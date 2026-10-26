# Correspondence dependency engine — COE-001 / COE-002

The engine is a pure aggregate transition library. A single mailbox owns scoped threads, drafts, grants, suppressions, intents, receipts and events. Transitions clone input state and return a new revision, a result and optional gateway commands. Errors leave input state unchanged. Context and stored state are trusted host inputs; untrusted mail bodies never become actors, roles, commands or policy. This foundation supplies no authentication server, durable database or external gateway.

## Authority and defaults

Construction requires a human with control permission. Defaults are human control, no connection, no grants and no outbound effects. Human-issued grants bind scope, mailbox, mode, actors, recipients, purpose, current epochs, activation, expiry, sends, followups and cooldown. Queued intents reserve budget; handoff consumes it once, including uncertain outcomes. Recipient cooldown and unresolved-send exclusion span grants within this mailbox. Cross-mailbox suppression, coordination and limits are host responsibilities.

Human takeover and context, authorization or suppression changes fence pending work. Draft changes and reply ingestion invalidate the thread context. Trash/spam cancel pending dispatch. Replies pause autonomous contact until a human resumes it; resume still requires a fresh draft. Lifting a suppression requires human authority and a consent note and never resumes a thread by itself.

## Commit and handoff contract

1. Authenticate an actor outside this package. Derive tenant, project, roles and purpose from trusted identity/policy. Do not accept them from mail, model output or arbitrary client headers.
2. Load scoped state and call `transitionCorrespondence`. Persist the returned aggregate under compare-and-swap on the previous revision, in the same transaction as durable effect bookkeeping. If the revision changed, discard the candidate commands and recompute against current state.
3. Preparing dispatch creates a short ticket. Handoff rechecks draft digest, epochs, suppression, current grant, limits, cooldown and ticket validity. Only handoff emits a send description and consumes budget.
4. Persist the handoff before releasing the command. `assertCommittedHandoff` checks its digest against committed state; it cannot prove database durability or one-shot consumption. The host must atomically consume the handoff once. It is not a retry permission or an exactly-once delivery guarantee.
5. Record authenticated provider outcomes. Crash/timeout/transport uncertainty must become `markUncertain` or an unknown outcome. After an execution crash, use the committed handoff to mark uncertainty, never resend it. Reconciliation is read-only and rate limited. Missing records leave the send uncertain. An uncertain recipient blocks fresh intents even under a new grant.

If takeover commits before handoff, the old dispatch candidate loses revision comparison and the ticket is cancelled. If handoff commits first, takeover reports the handoff as unrecallable; it does not claim to retract an external send. Tests exercise both orderings. No database transaction or one-shot gateway is supplied by this foundation.

Input IDs bind canonical command content, actor ID/kind and purpose. Replays return their original result without new effects. Reuse under different content or authority fails closed. Provider reply IDs also bind exact evidence and thread identity.

## Mail and evidence

Human read permission is required for ordinary mailbox views. Scope is checked before projection. Flags, archive, trash and spam are local. All Mail excludes trash/spam. Results omit grants and credential handles, and return copies of mutable records.

Authenticated provider ingress binds provider, account and authorization epoch. Reply content retains an attributed sender with `verification: unverified`, `policyAuthority: false` and `delivery: received-unverified`. Provider ingress authentication does not verify a sender's factual claims. Untrusted text can restrict contact through optout detection but cannot issue grants, resume autonomy or change control. Render projected text as text in the host; this library provides no HTML renderer.

## Providers and limits of acceptance

`applyFakeProvider` is the only execution simulator. It has no network or credential access, including accept-then-timeout behavior. Its remembered receipts let tests distinguish provider acceptance from a timeout without resending.

Outbound Gmail and Graph functions in `adapters.ts` return protocol descriptions and accept fake response fixtures. The read-only synchronization SDK is specified separately in [SYNC.md](SYNC.md). They never call fetch, OAuth, SMTP or provider SDKs. A credential handle is an opaque external reference, never a secret. Gmail reconciliation requires a fetched SENT record with exact Message-ID and handoff header; search hits alone are insufficient. Graph matches the handoff header and a lower timestamp bound on authenticated sent-items records. Multiple matches remain unknown. The Graph JSON description does not preserve arbitrary threading headers or provide full pagination; neither provider adapter is certified for live operation. The host must authenticate records for the indicated account, fetch complete evidence, and handle pagination without converting absence into a retry.

There is no live-provider enablement switch or deployed gateway in this package. Adding real transport, credentials, persistence or operational acceptance is separate work. This foundation contains no deployment data, downstream orchestrator or actual outreach.

## Verification and registry

`registry/prs.json` is the single canonical plan, using Identity's shared `pr-contract.mjs` format. COE-001 is the merged foundation mapped to real PR #1. COE-002 is the second bounded SDK unit mapped to real PR #2, depending on COE-001. A mapped PR, an implementation, passing local tests, CI success, merge and operational acceptance are distinct. `registry/roadmap.json` is retired, with no second unit list.

`npm run check` validates strict source/tests, fake integration, authorization failures, takeover race orderings, stale tickets, optouts, grant limits, reply evidence, no-retry uncertainty, protocol encodings, registry structure and the pinned contract hash. CI runs the same command on Node 24 from `npm ci`. No live provider or deployment acceptance has been performed.

## Provider mailbox synchronization

The SDK in `sync.ts` uses a read-only injected transport and a transactional store interface. It atomically persists each normalized provider page, unverified reply ingestion and cursor with both mailbox and sync revision comparisons. Official endpoint sources, limits, epoch and account fences, stale-cursor recovery and quarantine behavior are documented in [SYNC.md](SYNC.md). Provider metadata updates never authorize outbound sends.
