# Durable correspondence persistence — COE-003

`@accountability/correspondence/durable` exports `CorrespondenceRepository`, a durable aggregate command adapter and `MailboxSyncStore` factory. It imports the public `Database`, `UnitOfWork` and `scoped` exports from `@accountability/evidence/database` at exact git commit `dce7105a70b42d77afe4cd48d34723331447037c`. Both package manifest and lockfile pin this commit; the package check verifies the pin and compiled ESM resolution.

This is reuse of a **generic persistence SDK in a separate, dedicated correspondence database**. It is not permission to connect to Evidence or intake operational databases, their records, their credentials or their tables. No database implementation or SQL migration is vendored into this repository. The Evidence SDK's migration and runtime role retain their upstream `evidence_*` names in the correspondence database; that naming does not make it a shared operational database.

## Setup and exported API

The host provisions a fresh correspondence database and applies the installed dependency's actual `migrations/001_foundation.sql` as its migration owner. The migration can be located with:

```ts
const migration = new URL('../migrations/001_foundation.sql',
  import.meta.resolve('@accountability/evidence/database'));
```

Use a separate restricted LOGIN granted the SDK's `evidence_runtime` role, with no owner, superuser, bypass-RLS, role-creation, database-creation or replication privileges and no public-schema CREATE privilege. `scoped` checks the actual authenticated session identity before lowering its role and setting transaction-local tenant/project scope. A connection authenticated as an owner does not become acceptable through `SET ROLE`.

The repository takes an already configured `Database`; connection secrets stay in the host's driver configuration. The host must authenticate every `Context`, including tenant/project, actor, roles, purpose, request ID and time. Neither a database role nor a claimed actor display name substitutes for application authentication.

```ts
import { CorrespondenceRepository } from '@accountability/correspondence/durable';
import type { Database } from '@accountability/evidence/database';

export function correspondenceRepository(dedicatedCorrespondenceDatabase: Database) {
  return new CorrespondenceRepository(dedicatedCorrespondenceDatabase);
}
```

| Method | Behavior |
| --- | --- |
| `initialize(context, input)` | Validates constructor authority and atomically creates a mailbox at domain revision zero. Existing IDs conflict. |
| `load(context, mailboxId)` | Reads the latest scoped snapshot. It requires correspondence read permission or an authenticated ingress/gateway service role. |
| `execute(context, mailboxId, expectedDomainRevision, command)` | Checks the domain revision, runs the actual state machine and persists using the current storage revision. Replays validate persisted command receipts and emit no new effects. |
| `openSyncStore(context, binding)` | Creates/opens a generation-bound synchronization store for one configured provider/account/collection and current authorization epoch. |
| `consumeHandoff(context, mailboxId, command)` | Commits a one-shot consumption marker and uncertain intent state before returning the command and a generation-bound consumption handle. |
| `recordHandoffOutcome(context, handle, outcome)` | Checks scope, marker generation, command digest, actor and intent before persisting the ordinary state-machine outcome. |

The adapter is an internal trusted-backend interface, not a generic HTTP handler or a public API that accepts arbitrary caller contexts. Raw `Database` and `UnitOfWork` capabilities must not be given to untrusted clients. Responses must be projected appropriately before returning to external consumers.

## Atomic state and revisions

The implementation stores one generic KV value per mailbox, under `correspondence-mailbox-v1` and a deterministic mailbox key. Its schema contains the correspondence aggregate, a map of synchronization slots and a map of one-shot handoff consumption markers. No intake tables or specialized Evidence content operations are used. The SDK supplies scoped immutable revisions, compare-and-swap, audit and transaction rollback.

A mailbox's **storage revision** advances for every persisted wrapper change. Its **domain revision** advances for actual correspondence transitions. Each synchronization slot additionally has its own **checkpoint revision** and **generation**. Keeping these distinct allows checkpoint-only commits without pretending a domain event occurred.

Each sync load reads a single KV record, so it cannot combine an old aggregate with a new checkpoint from another statement. Commit checks the expected aggregate domain revision and checkpoint revision, validates the session binding/generation, then writes the entire value using the underlying storage revision. The SDK's project lock and storage compare-and-swap reject writers racing after the read. A conflict returns false to the synchronization SDK, which rejects that page; no cursor is separately acknowledged.

An ingress commit is not allowed to submit an arbitrary edited aggregate. The adapter reconstructs every appended reply-ingestion command and replays it through `transitionCorrespondence` using the captured ingress context. The result must exactly match the candidate aggregate. Changes to control, grants, existing evidence, receipts or unrelated events fail this comparison. Cache records must have unique provider/account/message keys and retain prior records as tombstones.

The sync slot key identifies the provider account and collection. Reopening the same binding retains the current checkpoint and generation. A new authorization epoch creates a new checkpoint with an incremented generation. Every load and commit checks current mailbox connection, tenant/project, account, address, epoch, binding digest and captured generation. Old sessions cannot commit after reconnect or explicit generation supersession. Cross-account IDs remain separate; reconnecting the same account reuses immutable provider-message evidence already in the aggregate.

Call `openSyncStore` for each synchronization invocation using the same authenticated context and timestamp supplied to `synchronizeMailbox`. The returned store captures that context and binding before asynchronous work. It is not a long-lived source of refreshed authentication or clock values.

## Handoff ordering and crash safety

A successful `execute(..., handoff)` returns only after the handoff state and its grant usage have committed. Its gateway commands are descriptions of committed work, not permission to repeat an external action. Before an external gateway may use a description, it must call `consumeHandoff` exactly once.

Consumption persists the exact command digest, actor, consumption generation and uncertain intent state in the same record before returning. There is no lease-expiry reclaim, generic retry job or resend method for consumed handoffs. `recordHandoffOutcome` accepts a matching handle, and normal authenticated read-only reconciliation remains available. A stale handle, altered command, duplicate consumption or terminal outcome conflict is rejected.

If a process crashes or loses its database commit acknowledgement around consumption, the caller cannot know whether a provider was contacted. Reload durable state. A committed marker remains consumed even when no network request actually happened; this can intentionally leave an unsent message uncertain. The system does not claim exactly-once external delivery or infer non-acceptance from elapsed time. It never grants a second execution permission to resolve ambiguity.

The existing takeover boundary remains the committed handoff: takeover before handoff cancels/fences pending work, while takeover after handoff reports it as unrecallable. Consumption does not move that boundary or claim that an already committed external handoff can be recalled. No provider is invoked from inside a database transaction. Transports and credentials remain separate; this PR contains no live provider execution.

## Integration evidence and limits

The PGlite tests load the real installed migration through the pinned compiled package and run the real `scoped`/`UnitOfWork` implementation. They create a restricted embedded LOGIN role and set session authorization to that role. They verify FORCE RLS, owner rejection, cross-scope isolation, atomic ingress/cursor persistence, rollback after a real record insert, no orphan revision after rollback, unchanged head/audit, domain and checkpoint CAS, takeover during ingress, concurrent local writers, reconnect/generation fences, command replay, handoff commit rollback, consumed/outcome handle fences and lost consumption acknowledgement.

Filesystem tests close and reopen PGlite on the same directory, reload the cursor/evidence, replay ingress without duplication, and confirm consumed uncertain handoffs remain unavailable for resend. All provider responses are fake; no provider credentials, email, OAuth or network database is used.

**These tests do not prove multi-session network PostgreSQL behavior.** PGlite runs inside one embedded connection, and test session authorization is not a wire-level login. A production deployment must separately validate actual restricted-login authentication, multiple connections and transaction isolation, database version/privileges, independent database ownership, backups, restore, retention and operational failure handling. This PR's local tests and CI are source-level integration evidence, not live deployment or independent certification.

## Registry and acceptance

COE-003 is the sole added unit in this PR, depending on COE-002 and upstream ESP-002. The upstream dependency pin is recorded separately from acceptance status. `registry/prs.json` remains the only active work registry. The PR description records the actual final source SHA and its exact CI run before marking ready; earlier checkpoints or local passes are not substituted. Live/provider/network acceptance remains unperformed.
