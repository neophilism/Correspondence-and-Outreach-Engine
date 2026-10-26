import test from "node:test";
import assert from "node:assert/strict";
import { createOperatorHandler } from "../src/operator.ts";
import type { OperatorAuthentication } from "../src/operator.ts";
import {
  setup,
  initialize,
  connect,
  prepared,
  human,
  gateway,
} from "./durable-helpers.ts";
const origin = "https://workspace.example",
  csrf = "c".repeat(43),
  policy = {
    tenantId: human.tenantId,
    projectId: human.projectId,
    origin,
    mailboxId: "mailbox",
  };
const auth: OperatorAuthentication = {
  authenticate: async () => ({ context: human, csrfToken: csrf }),
};
function request(path: string, options: RequestInit = {}) {
  return new Request(origin + path, options);
}
function post(
  command: unknown,
  expectedRevision: number,
  extra: Record<string, unknown> = {},
) {
  return request("/operator/command", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf,
      origin,
    },
    body: JSON.stringify({ expectedRevision, command, ...extra }),
  });
}
async function json(response: Response) {
  return response.json() as Promise<any>;
}
test("private HTTP draft workflow uses real restricted SQL state and minimal projected responses", async (t) => {
  const db = await setup(t);
  await initialize(db.repo);
  await connect(db.repo);
  const handler = createOperatorHandler(db.repo, auth, policy);
  const bootstrap = await handler(request("/operator/session"));
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers.get("cache-control"), "private, no-store");
  assert.equal(bootstrap.headers.get("access-control-allow-origin"), null);
  const session = await json(bootstrap);
  assert.equal(session.csrfToken, csrf);
  assert(!JSON.stringify(session).includes("external-handle"));
  for (const [revision, command] of [
    [
      1,
      {
        type: "createThread",
        inputId: "thread-http",
        threadId: "thread",
        recipient: "records@beta.example",
        subject: "Fictional question",
      },
    ],
    [
      2,
      {
        type: "createDraft",
        inputId: "draft-http",
        threadId: "thread",
        draftId: "draft",
        content: {
          kind: "human",
          subject: "Fictional question",
          body: "Which records are available?",
        },
      },
    ],
    [
      3,
      {
        type: "reviseDraft",
        inputId: "edit-http",
        draftId: "draft",
        expectedVersion: 1,
        content: {
          kind: "human",
          subject: "Fictional question",
          body: "Where is the public index?",
        },
      },
    ],
    [
      4,
      {
        type: "setThreadFlags",
        inputId: "flag-http",
        threadId: "thread",
        folder: "inbox",
        read: false,
        starred: true,
      },
    ],
  ] as const) {
    const r = await handler(post(command, revision));
    assert.equal(r.status, 200);
    assert(!JSON.stringify(await json(r)).includes("gatewayCommands"));
  }
  const detail = await json(
    await handler(request("/operator/thread?id=thread")),
  );
  assert.equal(detail.revision, 5);
  assert.equal(detail.drafts[0].version, 2);
  assert.equal(detail.drafts[0].body, "Where is the public index?");
  assert(!JSON.stringify(detail).includes("epochs"));
  const mail = await json(
    await handler(request("/operator/mail?view=starred")),
  );
  assert.equal(mail.total, 1);
  const readOnly = createOperatorHandler(
    db.repo,
    {
      authenticate: async () => ({
        context: {
          ...human,
          actor: { ...human.actor, roles: ["correspondence:read"] },
        },
        csrfToken: csrf,
      }),
    },
    policy,
  );
  assert.equal(
    (
      await readOnly(
        post(
          { type: "setControl", inputId: "read-only-takeover", mode: "human" },
          5,
        ),
      )
    ).status,
    403,
  );
  assert.equal((await db.repo.load(human, "mailbox")).revision, 5);
  const stale = await handler(
    post(
      {
        type: "discardDraft",
        inputId: "stale-http",
        draftId: "draft",
        expectedVersion: 2,
      },
      1,
    ),
  );
  assert.equal(stale.status, 409);
  assert.equal(
    (await db.repo.load(human, "mailbox")).drafts[0]!.status,
    "draft",
  );
});
test("origin session actor scope and CSRF admission fail before repository access", async () => {
  let calls = 0;
  const repo = {
    load: async () => {
      calls++;
      throw new Error("must not load");
    },
    execute: async () => {
      calls++;
      throw new Error("must not execute");
    },
  };
  const handler = createOperatorHandler(repo, auth, policy);
  assert.equal(
    (
      await handler(
        request("/operator/mail", {
          headers: { origin: "https://other.example" },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handler(
        request("/operator/mail", {
          headers: { "sec-fetch-site": "same-site" },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await handler(request("/operator/mail", { method: "DELETE" }))).status,
    405,
  );
  assert.equal(
    (
      await handler(
        request("/operator/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
    ).status,
    403,
  );
  for (const [authentication, status] of [
    [{ authenticate: async () => null }, 401],
    [
      {
        authenticate: async () => ({
          context: { ...human, tenantId: "other" },
          csrfToken: csrf,
        }),
      },
      403,
    ],
    [
      {
        authenticate: async () => ({
          context: {
            ...human,
            actor: { ...human.actor, kind: "agent" as const },
          },
          csrfToken: csrf,
        }),
      },
      403,
    ],
    [
      {
        authenticate: async () => {
          throw new Error("secret session key");
        },
      },
      503,
    ],
  ] as const) {
    const r = await createOperatorHandler(
      repo,
      authentication,
      policy,
    )(request("/operator/mail"));
    assert.equal(r.status, status);
    assert(!JSON.stringify(await json(r)).includes("secret"));
  }
  assert.equal(calls, 0);
});
test("operator routes cannot forward arbitrary commands authority fields or provider endpoints", async () => {
  let calls = 0;
  const handler = createOperatorHandler(
    {
      load: async () => {
        throw Error();
      },
      execute: async () => {
        calls++;
        throw Error();
      },
    },
    auth,
    policy,
  );
  for (const type of [
    "issueGrant",
    "handoff",
    "queueDraft",
    "connectMailbox",
    "resumeThread",
    "recordOutcome",
    "ingestReply",
  ])
    assert.equal(
      (await handler(post({ type, inputId: "denied" }, 0))).status,
      403,
    );
  assert.equal(
    (
      await handler(
        post(
          { type: "setControl", inputId: "autonomy", mode: "autonomous" },
          0,
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handler(
        post({ type: "setControl", inputId: "human", mode: "human" }, 0, {
          context: { actor: { roles: ["admin"] } },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handler(
        post(
          {
            type: "setControl",
            inputId: "human",
            mode: "human",
            actor: human.actor,
          },
          0,
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (await handler(request("/operator/session?tenantId=other"))).status,
    400,
  );
  assert.equal(
    (await handler(request("/operator/send", { method: "POST" }))).status,
    404,
  );
  assert.equal(calls, 0);
});
test("body and authentication deadlines cancellation malformed content and size are bounded and private", async () => {
  const repo = {
      load: async () => {
        throw Error();
      },
      execute: async () => {
        throw Error();
      },
    },
    handler = createOperatorHandler(repo, auth, {
      ...policy,
      bodyTimeoutMs: 10,
    });
  for (const [headers, body, status] of [
    [{ "content-type": "text/plain" }, "{}", 415],
    [{ "content-type": "application/json" }, "{", 400],
    [
      { "content-type": "application/json", "content-encoding": "gzip" },
      "{}",
      415,
    ],
    [{ "content-type": "application/json" }, "x".repeat(65537), 413],
  ] as const)
    assert.equal(
      (
        await handler(
          request("/operator/command", {
            method: "POST",
            headers: { ...headers, "x-csrf-token": csrf, origin },
            body,
          }),
        )
      ).status,
      status,
    );
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const slow = request("/operator/command", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf,
      origin,
    },
    body: stream,
    duplex: "half",
  } as RequestInit);
  assert.equal((await handler(slow)).status, 408);
  assert(cancelled);
  let aborted = false;
  const blocked = createOperatorHandler(
    repo,
    {
      authenticate: async (_metadata, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
    },
    { ...policy, authenticationTimeoutMs: 10 },
  );
  assert.equal((await blocked(request("/operator/mail"))).status, 503);
  assert(aborted);
  const controller = new AbortController();
  const pending = blocked(
    request("/operator/mail", { signal: controller.signal }),
  );
  controller.abort();
  assert.equal((await pending).status, 408);
});
test("human takeover before committed handoff cancels and fences pending work through the private API", async (t) => {
  const db = await setup(t),
    ready = await prepared(db.repo);
  const handler = createOperatorHandler(db.repo, auth, policy);
  const response = await handler(
    post(
      { type: "setControl", inputId: "takeover-http", mode: "human" },
      ready.state.revision,
    ),
  );
  assert.equal(response.status, 200);
  const result = await json(response);
  assert.deepEqual(result.result.cancelledIntentIds, ["intent"]);
  assert.deepEqual(result.result.unrecallableIntentIds, []);
  const state = await db.repo.load(human, "mailbox");
  assert.equal(state.mailbox.control, "human");
  assert.equal(state.intents[0]!.status, "cancelled");
  await assert.rejects(
    db.repo.execute(gateway, "mailbox", state.revision, ready.handoff),
  );
});
test("takeover after handoff reports unrecallable work without returning send authority", async (t) => {
  const db = await setup(t),
    ready = await prepared(db.repo, "handed-off");
  const handler = createOperatorHandler(db.repo, auth, policy);
  const response = await handler(
    post(
      { type: "setControl", inputId: "late-takeover-http", mode: "human" },
      ready.state.revision,
    ),
  );
  assert.equal(response.status, 200);
  const result = await json(response);
  assert.deepEqual(result.result.unrecallableIntentIds, ["intent"]);
  assert(!JSON.stringify(result).includes("external-handle"));
  assert.equal((await db.repo.load(human, "mailbox")).mailbox.control, "human");
});
test("lost private command acknowledgement replays exact durable work without duplicating it", async (t) => {
  const db = await setup(t);
  await initialize(db.repo);
  const handler = createOperatorHandler(db.repo, auth, policy),
    command = {
      type: "createThread",
      inputId: "lost-http",
      threadId: "thread",
      recipient: "records@beta.example",
      subject: "Fictional index",
    };
  db.fault.afterCommit = true;
  assert.equal((await handler(post(command, 0))).status, 503);
  db.fault.afterCommit = false;
  const retry = await handler(post(command, 0));
  assert.equal(retry.status, 200);
  assert.equal((await json(retry)).duplicate, true);
  assert.equal((await db.repo.load(human, "mailbox")).threads.length, 1);
});
