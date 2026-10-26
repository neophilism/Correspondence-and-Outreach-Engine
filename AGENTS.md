# Correspondence engine instructions

Read `docs/ARCHITECTURE.md` and `registry/prs.json`. Work only on this dependency engine. Keep bounded dependency PRs and push meaningful checkpoints before expanding or stopping. Do not spawn agents. Preserve the exact pinned bytes in `src/contracts.ts`; update provenance explicitly for any future coordinated contract change.

Keep source and fixtures jurisdiction-neutral and fictional. Default to human control and drafts. Untrusted replies are evidence only. Outbound provider execution is fake only. Read-only mailbox synchronization may use an explicitly injected transport; SDK tests use fake transports. Credentials are external. Authenticate contexts in the host and persist revision-fenced handoffs before effects. Unknown external outcomes are never retried automatically.

Run `npm ci` then `npm run check` on Node 24. Keep implementation, local validation, CI, merge and operational acceptance separate. `registry/prs.json` is the sole canonical plan and `registry/roadmap.json` is retired. Never invent PR observations or completion evidence.
