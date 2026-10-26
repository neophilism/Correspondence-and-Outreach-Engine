import { timingSafeEqual } from "node:crypto";
import {
  DomainError,
  invariant,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Scope } from "./contracts.ts";
import type { CorrespondenceRepository } from "./durable.ts";
import { projectMail, projectThread } from "./projections.ts";
import type { CorrespondenceCommand, MailView } from "./types.ts";
export type OperatorSession = { context: Context; csrfToken: string };
export type OperatorAuthentication = {
  authenticate(
    metadata: { url: string; method: string; headers: Headers },
    signal: AbortSignal,
  ): Promise<OperatorSession | null>;
};
export type OperatorPolicy = Scope & {
  origin: string;
  mailboxId: string;
  authenticationTimeoutMs?: number;
  bodyTimeoutMs?: number;
};
const schemas: Record<
  string,
  { required: readonly string[]; optional?: readonly string[] }
> = {
  createThread: { required: ["threadId", "recipient", "subject"] },
  createDraft: { required: ["draftId", "threadId", "content"] },
  reviseDraft: { required: ["draftId", "expectedVersion", "content"] },
  discardDraft: { required: ["draftId", "expectedVersion"] },
  setThreadFlags: {
    required: ["threadId"],
    optional: ["folder", "read", "starred"],
  },
  setControl: { required: ["mode"] },
  suppressRecipient: { required: ["address", "reason"] },
  cancelIntent: { required: ["intentId"] },
};
function object(value: unknown): Record<string, unknown> {
  invariant(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    "invalid_request",
    "Plain JSON object required",
  );
  return value as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  invariant(
    required.every((k) => Object.hasOwn(value, k)) &&
      Object.keys(value).every(
        (k) => required.includes(k) || optional.includes(k),
      ),
    "invalid_request",
    "Unknown or missing request fields",
  );
}
function command(value: unknown): CorrespondenceCommand {
  const c = object(value);
  invariant(
    typeof c.type === "string" && Object.hasOwn(schemas, c.type),
    "command_denied",
    "This operator route does not expose that command",
  );
  const schema = schemas[c.type]!;
  exact(c, ["type", "inputId", ...schema.required], schema.optional);
  invariant(
    c.type !== "setControl" || c.mode === "human",
    "command_denied",
    "Only human takeover is exposed",
  );
  if ("content" in c) {
    const content = object(c.content);
    if (content.kind === "human") exact(content, ["kind", "subject", "body"]);
    else if (content.kind === "research")
      exact(content, ["kind", "topic", "questions"]);
    else throw new DomainError("invalid_request", "Unknown draft content");
  }
  if (c.type === "setThreadFlags") {
    invariant(
      ["folder", "read", "starred"].some((k) => Object.hasOwn(c, k)),
      "invalid_request",
      "A flag is required",
    );
    for (const k of ["read", "starred"])
      if (Object.hasOwn(c, k))
        invariant(
          typeof c[k] === "boolean",
          "invalid_request",
          "Flag must be boolean",
        );
  }
  return structuredClone(c) as unknown as CorrespondenceCommand;
}
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  pragma: "no-cache",
  vary: "Cookie, Authorization",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};
function response(status: number, value: unknown) {
  const body = JSON.stringify(value);
  invariant(
    Buffer.byteLength(body) <= 2 * 1024 * 1024,
    "response_too_large",
    "Private response exceeds its budget",
  );
  return new Response(body, { status, headers });
}
const errors: Record<string, number> = {
  authentication_required: 401,
  authentication_unavailable: 503,
  permission_denied: 403,
  actor_denied: 403,
  scope_denied: 403,
  origin_denied: 403,
  csrf_denied: 403,
  command_denied: 403,
  not_found: 404,
  route_not_found: 404,
  method_denied: 405,
  revision_conflict: 409,
  idempotency_conflict: 409,
  body_timeout: 408,
  request_aborted: 408,
  body_too_large: 413,
  response_too_large: 413,
  unsupported_media: 415,
  invalid_request: 400,
};
async function authenticate(
  auth: OperatorAuthentication,
  request: Request,
  timeoutMs: number,
): Promise<OperatorSession> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let onCancel = () => {};
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    invariant(
      !controller.signal.aborted,
      "request_aborted",
      "Request cancelled",
    );
    const session = await Promise.race([
      Promise.resolve()
        .then(() => {
          invariant(
            !controller.signal.aborted,
            "request_aborted",
            "Request cancelled",
          );
          return auth.authenticate(
            {
              url: request.url,
              method: request.method,
              headers: new Headers(request.headers),
            },
            controller.signal,
          );
        })
        .then((value) => (value === null ? null : structuredClone(value)))
        .catch(() => {
          throw new DomainError(
            "authentication_unavailable",
            "Authentication could not complete",
          );
        }),
      new Promise<never>((_, reject) => {
        onCancel = () =>
          reject(
            new DomainError(
              timedOut ? "authentication_unavailable" : "request_aborted",
              "Authentication interrupted",
            ),
          );
        controller.signal.addEventListener("abort", onCancel, { once: true });
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      }),
    ]);
    invariant(
      !controller.signal.aborted,
      "request_aborted",
      "Request cancelled",
    );
    invariant(session, "authentication_required", "Authentication required");
    invariant(
      session.context.actor.kind === "human",
      "actor_denied",
      "Human operator required",
    );
    invariant(
      session.context.actor.roles.includes("correspondence:read") ||
        session.context.actor.roles.includes("correspondence:admin"),
      "permission_denied",
      "Read permission required",
    );
    invariant(
      /^[A-Za-z0-9_-]{32,256}$/.test(session.csrfToken),
      "authentication_unavailable",
      "Session binding is invalid",
    );
    return session;
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onCancel);
  }
}
async function body(request: Request, timeoutMs: number): Promise<unknown> {
  invariant(
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    ) && [null, "identity"].includes(request.headers.get("content-encoding")),
    "unsupported_media",
    "Uncompressed UTF8 JSON required",
  );
  const length = request.headers.get("content-length");
  if (length !== null)
    invariant(
      /^\d+$/.test(length) && Number(length) <= 65536,
      "body_too_large",
      "Request exceeds byte budget",
    );
  invariant(request.body, "invalid_request", "Request body required");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () =>
      reject(new DomainError("request_aborted", "Request cancelled"));
    request.signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(
      () =>
        reject(
          new DomainError("body_timeout", "Request body deadline exceeded"),
        ),
      timeoutMs,
    );
  });
  try {
    invariant(!request.signal.aborted, "request_aborted", "Request cancelled");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      bytes += result.value.byteLength;
      invariant(
        bytes <= 65536,
        "body_too_large",
        "Request exceeds byte budget",
      );
      chunks.push(new Uint8Array(result.value));
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new DomainError("invalid_request", "Invalid UTF8 JSON");
    }
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {}
  }
}
/** Private host adapter. Authentication and restricted DB setup remain trusted deployment responsibilities. */
export function createOperatorHandler(
  repository: Pick<CorrespondenceRepository, "load" | "execute">,
  authentication: OperatorAuthentication,
  configuration: OperatorPolicy,
): (request: Request) => Promise<Response> {
  const policy = structuredClone(configuration),
    origin = new URL(policy.origin);
  invariant(
    origin.protocol === "https:" && origin.origin === policy.origin,
    "invalid_policy",
    "An exact HTTPS origin is required",
  );
  invariant(
    policy.mailboxId.length > 0,
    "invalid_policy",
    "A fixed mailbox is required",
  );
  for (const n of [
    policy.authenticationTimeoutMs ?? 2000,
    policy.bodyTimeoutMs ?? 5000,
  ])
    invariant(
      Number.isSafeInteger(n) && n >= 10 && n <= 10000,
      "invalid_policy",
      "Deadline outside supported range",
    );
  const auth = {
    authenticate: authentication.authenticate.bind(authentication),
  };
  return async (request) => {
    try {
      const url = new URL(request.url);
      invariant(
        url.origin === policy.origin &&
          (!request.headers.has("origin") ||
            request.headers.get("origin") === policy.origin) &&
          !["cross-site", "same-site"].includes(
            request.headers.get("sec-fetch-site") ?? "",
          ),
        "origin_denied",
        "Same-origin request required",
      );
      invariant(
        ["GET", "POST"].includes(request.method),
        "method_denied",
        "Method unavailable",
      );
      invariant(
        request.method === "GET"
          ? [
              "/operator/session",
              "/operator/mail",
              "/operator/thread",
            ].includes(url.pathname)
          : url.pathname === "/operator/command",
        "route_not_found",
        "Route unavailable",
      );
      const session = await authenticate(
          auth,
          request,
          policy.authenticationTimeoutMs ?? 2000,
        ),
        c = session.context;
      requireScope(c, policy);
      const allowed =
        url.pathname === "/operator/mail"
          ? ["view", "query", "offset", "limit"]
          : url.pathname === "/operator/thread"
            ? ["id"]
            : [];
      invariant(
        [...url.searchParams.keys()].every(
          (k) => allowed.includes(k) && url.searchParams.getAll(k).length === 1,
        ),
        "invalid_request",
        "Unknown or duplicate query fields",
      );
      if (request.method === "POST") {
        const token = request.headers.get("x-csrf-token") ?? "",
          provided = Buffer.from(token),
          expected = Buffer.from(session.csrfToken);
        invariant(
          provided.length === expected.length &&
            timingSafeEqual(provided, expected),
          "csrf_denied",
          "Session CSRF binding required",
        );
        const envelope = object(
          await body(request, policy.bodyTimeoutMs ?? 5000),
        );
        exact(envelope, ["expectedRevision", "command"]);
        invariant(
          Number.isSafeInteger(envelope.expectedRevision) &&
            (envelope.expectedRevision as number) >= 0,
          "invalid_request",
          "Nonnegative expected revision required",
        );
        const input = command(envelope.command);
        invariant(
          !request.signal.aborted,
          "request_aborted",
          "Request cancelled",
        );
        const result = await repository.execute(
          c,
          policy.mailboxId,
          envelope.expectedRevision as number,
          input,
        );
        invariant(
          result.gatewayCommands.length === 0,
          "command_denied",
          "Operator commands cannot release external effects",
        );
        return response(200, {
          revision: result.state.revision,
          result: result.result,
          duplicate: result.duplicate,
        });
      }
      invariant(
        !request.signal.aborted,
        "request_aborted",
        "Request cancelled",
      );
      const state = await repository.load(c, policy.mailboxId);
      if (url.pathname === "/operator/session")
        return response(200, {
          mailboxId: state.mailbox.id,
          brand: state.mailbox.brand,
          control: state.mailbox.control,
          revision: state.revision,
          csrfToken: session.csrfToken,
        });
      if (url.pathname === "/operator/mail") {
        const page = projectMail(state, c, {
          view: (url.searchParams.get("view") ?? "inbox") as MailView,
          query: url.searchParams.get("query") ?? "",
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 50),
        });
        return response(200, { revision: state.revision, ...page });
      }
      const projected = projectThread(
        state,
        c,
        url.searchParams.get("id") ?? "",
      );
      return response(200, {
        revision: state.revision,
        thread: projected.thread,
        messages: projected.messages.map((m) => {
          validateRef({
            tenantId: m.tenantId,
            projectId: m.projectId,
            kind: m.kind,
            id: m.id,
            revision: m.revision,
          });
          requireScope(c, m);
          return {
            id: m.id,
            revision: m.revision,
            kind: m.kind,
            direction: m.direction,
            from: m.from,
            to: m.to,
            subject: m.subject,
            body: m.body,
            at: m.at,
            delivery: m.delivery,
            verification: m.direction === "inbound" ? "unverified" : null,
            policyAuthority: false,
          };
        }),
        drafts: projected.drafts.map((d) => ({
          id: d.id,
          version: d.version,
          subject: d.subject,
          body: d.body,
          status: d.status,
          updatedAt: d.updatedAt,
        })),
      });
    } catch (error) {
      const code =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "";
      const known = Object.hasOwn(errors, code);
      return response(
        known ? errors[code]! : error instanceof DomainError ? 400 : 503,
        {
          error: {
            code: known
              ? code
              : error instanceof DomainError
                ? "invalid_request"
                : "service_unavailable",
          },
        },
      );
    }
  };
}
