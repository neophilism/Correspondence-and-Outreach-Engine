import test from "node:test";
import assert from "node:assert/strict";
import { createOperatorHandler } from "../src/operator.ts";
import { setup, initialize, connect, human } from "./durable-helpers.ts";
const origin = "https://workspace.example",
  csrf = "c".repeat(43);
const policy = {
  tenantId: human.tenantId,
  projectId: human.projectId,
  origin,
  mailboxId: "mailbox",
};
const auth = {
  authenticate: async () => ({ context: human, csrfToken: csrf }),
};
const envelope = {
  expectedRevision: 1,
  command: {
    type: "createThread",
    inputId: "deadline-thread",
    threadId: "thread",
    recipient: "records@beta.example",
    subject: "Fictional records",
  },
};
function block() {
  const end = performance.now() + 40;
  while (performance.now() < end) {}
}
function post(body: BodyInit) {
  return new Request(origin + "/operator/command", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-csrf-token": csrf,
    },
    body,
    duplex: "half",
  } as RequestInit);
}
async function fixture(t: test.TestContext) {
  const f = await setup(t);
  await initialize(f.repo);
  await connect(f.repo);
  return f;
}
test("blocked authentication cannot return a private session after the monotonic deadline", async (t) => {
  const f = await fixture(t),
    handler = createOperatorHandler(
      f.repo,
      {
        authenticate: async () => {
          block();
          return { context: human, csrfToken: csrf };
        },
      },
      { ...policy, authenticationTimeoutMs: 10 },
    );
  assert.equal(
    (await handler(new Request(origin + "/operator/session"))).status,
    503,
  );
});
test("blocked authentication cannot commit a private operator command after deadline", async (t) => {
  const f = await fixture(t),
    handler = createOperatorHandler(
      f.repo,
      {
        authenticate: async () => {
          block();
          return { context: human, csrfToken: csrf };
        },
      },
      { ...policy, authenticationTimeoutMs: 10 },
    );
  assert.equal((await handler(post(JSON.stringify(envelope)))).status, 503);
  assert.equal((await f.repo.load(human, "mailbox")).revision, 1);
});
test("blocked body read cannot commit before a delayed timeout timer fires", async (t) => {
  const f = await fixture(t),
    handler = createOperatorHandler(f.repo, auth, {
      ...policy,
      bodyTimeoutMs: 10,
    });
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        block();
        c.enqueue(new TextEncoder().encode(JSON.stringify(envelope)));
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  assert.equal((await handler(post(body))).status, 408);
  assert.equal((await f.repo.load(human, "mailbox")).revision, 1);
});
test("successful and rejected authentication close their owned signals and sanitize callback diagnostics", async (t) => {
  const f = await fixture(t);
  for (const mode of ["ok", "throw"]) {
    let owned: AbortSignal | undefined;
    const handler = createOperatorHandler(
      f.repo,
      {
        authenticate: async (_m, s) => {
          owned = s;
          if (mode === "throw") throw Error("private-credential");
          return { context: human, csrfToken: csrf };
        },
      },
      policy,
    );
    const result = await handler(new Request(origin + "/operator/session"));
    assert.equal(result.status, mode === "ok" ? 200 : 503);
    assert.equal(owned?.aborted, true);
    assert.equal((await result.text()).includes("private-credential"), false);
  }
});
