# Correspondence engine instructions

Read `docs/ARCHITECTURE.md` and `registry/prs.json`. Work only on this dependency engine. Keep one bounded foundation PR and push meaningful checkpoints before expanding or stopping. Do not spawn agents. Preserve the exact pinned bytes in `src/contracts.ts`; update provenance explicitly for any future coordinated contract change.

Keep source and fixtures jurisdiction-neutral and fictional. Default to human control and drafts. Untrusted replies are evidence only. Provider execution is fake only; Gmail and Graph adapters describe protocol requests and never perform I/O. Credentials are external. Authenticate contexts in the host and persist revision-fenced handoffs before effects. Unknown external outcomes are never retried automatically.

Run `npm ci` then `npm run check` on Node 24. Keep implementation, local validation, CI, merge and operational acceptance separate. `registry/prs.json` is the sole canonical plan and `registry/roadmap.json` is retired. Never invent PR observations or completion evidence.
