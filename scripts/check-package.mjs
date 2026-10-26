import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(root, '.package-check-'));
try {
  const result = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
    { cwd: root, encoding: 'utf8' }));
  const archive = result[0];
  assert.ok(archive.files.some(file => file.path === 'dist/index.js'));
  assert.ok(archive.files.some(file => file.path === 'dist/index.d.ts'));
  assert.ok(!archive.files.some(file => file.path.startsWith('src/') || file.path.startsWith('node_modules/')));
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'correspondence-consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--no-audit', '--no-fund', join(temporary, archive.filename)],
    { cwd: consumer, stdio: 'pipe' });
  const installed = join(consumer, 'node_modules/@accountability/correspondence');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['.'].default, './dist/index.js');
  assert.equal(manifest.exports['./contracts'].default, './dist/contracts.js');
  await writeFile(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createAlphaCorrespondenceFixture, projectMail, createMailboxSyncState, synchronizeMailbox, transitionCorrespondence } from '@accountability/correspondence';
import { DomainError } from '@accountability/correspondence/contracts';
assert.match(import.meta.resolve('@accountability/correspondence'), /node_modules\\/.*\\/dist\\/index\\.js$/);
const fixture = createAlphaCorrespondenceFixture();
const human = fixture.steps[0].context;
assert.equal(projectMail(fixture.state, human).total, 1);
assert.equal(fixture.providerState.attempts[0].calls, 1);
assert.equal(new DomainError('example', 'example').code, 'example');
const syncBinding = { tenantId: 'example', projectId: 'research', mailboxId: 'mailbox', provider: 'gmail',
  accountRef: 'example-account', authEpoch: 1, address: 'reader@example.org', providerAccountId: 'reader@example.org', folderId: null };
assert.equal(createMailboxSyncState(syncBinding).cursor, null);
assert.equal(typeof synchronizeMailbox, 'function');
const connected = transitionCorrespondence(fixture.initial, human, { type: 'connectMailbox', inputId: 'installed-sync',
  connection: { provider: 'gmail', accountRef: 'example-account', connectionRef: 'external-handle', address: 'reader@example.org' } }).state;
const binding = { ...syncBinding, tenantId: connected.tenantId, projectId: connected.projectId, mailboxId: connected.mailbox.id };
let snapshot = { correspondence: connected, sync: createMailboxSyncState(binding) };
const pages = [{ emailAddress: binding.address, historyId: '100' }, { messages: [] }];
const transport = { binding, async read(request) {
  assert.equal(request.method, 'GET');
  return { status: 200, body: (async function* () { yield Buffer.from(JSON.stringify(pages.shift())); })() };
} };
const store = { async load() { return structuredClone(snapshot); }, async commit(input) {
  assert.equal(input.expectedSyncRevision, snapshot.sync.revision);
  assert.equal(input.expectedCorrespondenceRevision, snapshot.correspondence.revision);
  snapshot = structuredClone(input.next); return true;
} };
const ingress = fixture.steps.find(step => step.context.actor.kind === 'service').context;
const synchronized = await synchronizeMailbox({ context: ingress, binding, transport, store, limits: { maxPages: 1 } });
assert.equal(synchronized.pagesCommitted, 1);
assert.equal(snapshot.sync.cursor.kind, 'gmail-history');
assert.equal(pages.length, 0);
console.log('Installed compiled ESM package works from node_modules with fake fixture');
`);
  process.stdout.write(execFileSync(process.execPath, ['smoke.mjs'], { cwd: consumer, encoding: 'utf8' }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
