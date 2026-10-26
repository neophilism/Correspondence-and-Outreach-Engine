import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const bytes = await readFile(new URL('../src/contracts.ts', import.meta.url));
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== 'd86141cb7546a723f837a298e4ea6fef62692918f78f5aab2d72d6639987fcc5') throw new Error('Vendored Identity contracts differ from pinned provenance');
console.log('Identity contracts match pinned commit 2ecac5a7ec01e4470774ef545060b99dba38014d');
