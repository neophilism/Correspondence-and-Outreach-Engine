# Correspondence and Outreach Engine

Standalone Node 24 / strict TypeScript dependency engine for drafts, ordinary mailbox views, human takeover, bounded send grants and unverified reply evidence. There is no live provider transport. The provider simulator performs no I/O; Gmail and Graph adapters return protocol descriptions only. Credentials remain external.

```sh
npm ci
npm run check
```

`check` runs strict typechecking, adversarial domain tests, the declaration/JavaScript build, canonical PR registry validation and pinned contract verification. No monorepo files, database, network services or provider accounts are needed at runtime or during tests. Installing dev dependencies uses the lockfile. Node 24 is required for native TypeScript test execution; package consumers load compiled JavaScript from `dist`.

```ts
import { createCorrespondenceState, transitionCorrespondence, projectMail } from '@accountability/correspondence';
import type { Context } from '@accountability/correspondence/contracts';

// A trusted host supplies context after authentication, never from mail content.
const human: Context = {
  tenantId: 'example', projectId: 'research', purpose: 'records-inquiry',
  requestId: 'draft-example', now: '2030-01-01T00:00:00Z',
  actor: { id: 'editor', kind: 'human', roles: ['correspondence:control', 'correspondence:write', 'correspondence:read'] },
};
const initial = createCorrespondenceState(human, { mailboxId: 'research', brand: 'Example Research' });
const created = transitionCorrespondence(initial, human, {
  type: 'createThread', inputId: 'thread-1', threadId: 'records',
  recipient: 'reader@example.org', subject: 'Record availability',
});
const drafted = transitionCorrespondence(created.state, human, {
  type: 'createDraft', inputId: 'draft-1', draftId: 'inquiry', threadId: 'records',
  content: { kind: 'research', topic: 'Record availability', questions: ['Where can I find the records?'] },
});
console.log(projectMail(drafted.state, human, { view: 'drafts' }));
// drafted.gatewayCommands is empty. There is no connection or send grant.
```

The constructor defaults to human control with no connection or grant. Agents draft transparent, structured research inquiries with one to three short questions. Automation requires an explicit human-issued grant binding actor, recipient, purpose, epochs, time, budget and cooldown.

Mailbox projections provide inbox, archive, sent, drafts, unread, starred, trash, spam and All Mail, plus search and pagination. All Mail excludes trash/spam. These are local projections, not provider folder synchronization or a user interface.

`createAlphaCorrespondenceFixture()` is a deterministic fictional integration example, including a fake provider receipt and an unverified STOP reply. It sends nothing.

Consumers must authenticate contexts, persist state with atomic revision comparison, and release a handoff command once only after commit. A committed handoff is the point after which takeover reports an unrecallable send. Unknown external outcomes block repeat sends to that recipient and permit read-only reconciliation. Provider acceptance is not proof of delivery.

See [architecture](docs/ARCHITECTURE.md), [source provenance](docs/PROVENANCE.md), and the [canonical work registry](registry/prs.json). Contracts are vendored byte-identical from Identity commit `2ecac5a7ec01e4470774ef545060b99dba38014d`. The foundation is tracked in [PR #1](https://github.com/neophilism/Correspondence-and-Outreach-Engine/pull/1). Local checks, CI, merge and live acceptance are separate evidence.
