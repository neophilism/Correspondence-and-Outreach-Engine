# Correspondence and Outreach Engine

Jurisdiction-neutral dependency engine recovered from `accountability-machine/packages/correspondence/src`.

WIP code checkpoint: package, tests, CI and registry validation are pending. Draft-only defaults; fake provider execution only. Protocol encoders never contact providers. Credentials belong outside this repository.

`src/contracts.ts` is vendored byte-identical from Identity Authorization and Policy Engine commit `2ecac5a7ec01e4470774ef545060b99dba38014d`. Imports are local so the source has no monorepo dependency.

Consumers must authenticate context, enforce transactional revision comparison and persist handoffs before external execution. No live provider transport is included.
