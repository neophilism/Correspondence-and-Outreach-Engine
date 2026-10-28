# Private human operator gateway — COE-004

`@accountability/correspondence/operator` exports `createOperatorHandler(repository, authentication, policy)`, a Fetch Request/Response host adapter. The repository is the existing durable correspondence repository in its own dedicated database. Policy fixes one tenant, project, mailbox and exact HTTPS origin. There is no mailbox initializer, dynamic tenant selector or provider connection endpoint.

## Authentication boundary

The required trusted authentication adapter validates the deployment's existing session or identity provider and returns an authenticated human Context plus a current session-bound CSRF token. It receives a copy of request metadata and an abort signal, never the body. Derive tenant, project, actor, roles, purpose, request ID and time from verified server state; request URLs, headers, mail content and JSON claims do not establish identity. An authenticator that simply reflects a caller's actor/roles is insecure and outside this contract. No default authenticator or authentication bypass is provided.

Use a high-entropy session-specific base64url token of 32-256 characters. The authenticator must enforce session expiry/revocation and token rotation, and must not log cookies/tokens. Existing session cookies need the host's normal Secure, HttpOnly and SameSite configuration. The callback is read-only and must honor cancellation; the handler bounds awaiting it but cannot terminate arbitrary noncooperating callback code. Hosting, TLS termination, session storage and actual identity verification are separate deployment work.

The handler checks the configured origin, rejects foreign Origin and cross-site/same-site Fetch Metadata, and requires a constant-time matching X-CSRF-Token for every POST. A session GET returns the token only after authentication, with no CORS permission, no-store caching, JSON content type, nosniff and same-origin resource policy. Mount under the exact configured origin using a trusted server/proxy URL reconstruction; do not derive trusted origin from arbitrary forwarded headers. The frontend must use text rendering for response content.

## Routes

| Route | Behavior |
| --- | --- |
| GET /operator/session | Authenticated mailbox label/control, domain revision and current session CSRF token. |
| GET /operator/mail | Upstream projected mailbox page; view, query, offset and limit only. |
| GET /operator/thread?id=… | Minimal projected thread/messages/drafts, exact message revisions and unverified reply labels. |
| POST /operator/command | Exact JSON envelope `{expectedRevision, command}`; strict fields and command whitelist. |

Supported private commands are createThread, createDraft, reviseDraft, discardDraft, setThreadFlags, suppressRecipient, cancelIntent and setControl with mode human only. The existing state machine still enforces command-specific human roles, draft versions, context fences, suppression and scope. The read permission does not grant write/control permission. Unknown commands/fields and claimed actor/context fields fail closed. There are no grants, autonomy enablement, resume, provider ingress, queue, prepare, handoff, consume, outcome, connection, sending or publication routes. Responses never include dispatch descriptions, grants, credential/account handles or authorization epochs.

POST requires uncompressed UTF8 JSON, bounds actual streamed input to 64 KiB, 4096 chunks (including empty chunks), and total body-reading time (default 5 seconds). Authentication is separately bounded (default 2 seconds). Host-configured deadlines are 10-10000 milliseconds; output JSON is capped at 2 MiB. Oversized pages/threads fail explicitly rather than silently truncate. Error responses contain only safe codes, never provider errors, SQL, stack traces or caller body contents. All responses are private/no-store. Unknown routes/methods are rejected.

## Atomic edits and takeover

The repository performs revision-fenced durable transitions and actor-bound idempotent replay. A client loads a current revision, creates a stable command inputId, and submits that exact command with the expected revision. After conflict, reload and review before creating a different command; never change content under an existing inputId. After an unknown/lost acknowledgement, reload or replay the same command. A private edit may have committed even when its response was lost. Once a database transaction starts, aborting HTTP is not a promise to roll it back. The host must bound concurrent requests and enforce its own connection/query/transaction resource limits.

Human takeover before handoff cancels/fences pending work. After a committed handoff it reports unrecallable intent IDs; it does not claim to retract an external message. The private handler exposes no external executor. Its returned domain result is a receipt, not authority to send anything. It does not replace the backend's separate one-shot handoff consumption protocol.

The Visual inbox's read-only snapshot is separately implemented. Connecting authenticated compose/edit/flags/takeover controls and live updates to these routes remains downstream UI/host integration. No live mail, identity provider, server deployment or paid resource is created by this component.

## Validation and limits

Targeted tests use actual SDK migrations and a restricted PGlite login for draft edits, stale revisions, takeover on both sides of handoff and lost-acknowledgement replay. Admission tests cover origin, human scope/roles, CSRF, arbitrary command/authority fields, timeouts, cancellation, content types and stream limits. Installed-package smoke imports the compiled operator subpath and confirms an unauthenticated request cannot touch the repository. PGlite is not independent network-session PostgreSQL acceptance. Real host authentication, TLS/proxy configuration, browser integration/accessibility, production database sessions and operational acceptance remain separate.

## Monotonic HTTP admission checkpoint

The operator authentication and body stages now check a monotonic deadline before/after callback invocation, metadata copying, result copying/context validation, stream reads and UTF8 JSON parsing. Owned authentication signals close on every exit, including success. Authenticated context strings/time/roles are bounded before read authority is accepted. Existing routes, auth-before-body order, CSRF/domain checks and draft/human-control command whitelist remain unchanged.

Four actual restricted-migration/native-Fetch regressions FAILED on accepted main12f45d60eae22c13d513933f840b63ae673a7021: blocked authentication returned a session/committed a command after10ms deadline, blocked body read committed before delayed timer (200 rather than503/408), and successful authentication left its signal open. The tests use fictional local data and40ms synchronous callback blocking, not deployed authentication. Source/checkpoint validation is separate from final CI/merge and live acceptance.

Checks deny late acceptance; they cannot preempt JavaScript, undo callbacks, terminate an already-begun database transaction or establish rollback. Begun SQL remains awaited, and acknowledgement loss remains unknown. Trusted current host roles/session/CSRF/purpose/clock, database driver/concurrency/ingress limits and live qualification remain mandatory. No sending, provider network requests, resume, grants, publication or new routes are added.
