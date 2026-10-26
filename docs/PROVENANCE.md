# Source provenance

The foundation recovers the seven TypeScript files from `accountability-machine/packages/correspondence/src/` present in the recovery workspace. Their shared imports were rewritten to `./contracts.ts`. No upstream commit is asserted for the recovered workspace files.

`src/contracts.ts` is byte-identical to `src/contracts.ts` in [Identity commit 2ecac5a7ec01e4470774ef545060b99dba38014d](https://github.com/neophilism/Identity-Authorization-and-Policy-Engine/blob/2ecac5a7ec01e4470774ef545060b99dba38014d/src/contracts.ts), independently fetched through GitHub during this recovery. Git blob SHA: `6d6de860c507c9030cf8d46c7de2d70856ba55c2`. SHA-256: `d86141cb7546a723f837a298e4ea6fef62692918f78f5aab2d72d6639987fcc5`.

The PR registry contract, format document, validation script and TypeScript configuration were copied from the sibling Identity engine format. `registry/prs.json` is the only active plan; its initial unit is the foundation authorized for this repository. PR #1 is now merged. COE-002 adds the separately authorized bounded synchronization SDK in PR #2; `pullRequests` stays empty because no complete raw GitHub observation with its numeric database ID has been captured. Explicit `prs: [1]` records the verified association without inventing observation fields.

Recovered code fixes remove an upstream orchestrator claim from generated inquiries, give the standalone engine its own default display label, and exclude trash/spam from the All Mail projection. These changes preserve automation disclosure and are covered by tests.
