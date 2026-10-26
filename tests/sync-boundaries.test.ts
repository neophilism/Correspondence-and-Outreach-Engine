import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailboxSyncState, synchronizeMailbox, transitionCorrespondence } from '../src/index.ts';
import type { SyncBinding, ReadOnlyMailboxTransport } from '../src/index.ts';
import { error } from './helpers.ts';
import { gmailBase, gmailMessage, graphLink, graphMessage, response, syncHarness } from './sync-helpers.ts';

for (const link of [
  'https://remote.invalid/collect?$skiptoken=next',
  'https://graph.microsoft.com/v1.0/users/foreign/mailFolders/inbox/messages/delta?$skiptoken=next',
  'https://graph.microsoft.com/v1.0/users/provider-account-a/mailFolders/other/messages/delta?$skiptoken=next',
  'https://graph.microsoft.com/v1.0/users/provider-account-a/mailFolders/inbox/messages/delta?$skiptoken=next&access_token=not-a-credential',
  'https://graph.microsoft.com/v1.0/users/provider-account-a/mailFolders/inbox/messages/delta?$skiptoken=a&$skiptoken=b',
  'https://graph.microsoft.com/v1.0/users/provider-account-a/mailFolders/inbox/messages/delta?$skiptoken=next#fragment',
]) {
  test(`Graph rejects unbound continuation ${new URL(link).hostname}/${new URL(link).pathname.split('/').at(-1)}`, async () => {
    const h = syncHarness('graph'); h.add({ value: [], '@odata.nextLink': link });
    await assert.rejects(h.run(), error('sync_unsafe_cursor'));
    assert.equal(h.snapshot.sync.cursor, null); assert.equal(h.requests.length, 1); assert.equal(h.commits, 0);
  });
}

test('pagination loops and oversized provider arrays fail without checkpointing', async () => {
  const h = syncHarness('graph'); h.graphPage(); await h.run();
  h.add({ value: [{ id: 'one' }, { id: 'two' }], '@odata.deltaLink': graphLink('new') });
  await assert.rejects(h.run({ pageSize: 1 }), error('sync_page_limit')); assert.equal(h.snapshot.sync.revision, 1);
  const g = syncHarness(); g.gmailFull(gmailMessage(), 'same'); await g.run();
  g.add({ messages: [], nextPageToken: 'same' });
  await assert.rejects(g.run(), error('sync_cursor_loop')); assert.equal(g.snapshot.sync.revision, 1);
});

test('stream response byte bound stops reads and never commits a cursor', async () => {
  const h = syncHarness(); let chunksRead = 0;
  h.replies.push(() => ({ status: 200, body: (async function* () {
    for (let n = 0; n < 10; n++) { chunksRead++; yield Buffer.alloc(16); }
  })() }));
  await assert.rejects(h.run({ maxResponseBytes: 32 }), error('sync_response_too_large'));
  assert.equal(chunksRead, 3); assert.equal(h.commits, 0);
});

test('message byte bound rejects a provider get before parsing or checkpointing', async () => {
  const h = syncHarness(); h.gmailFull(gmailMessage('message-1', 'x'.repeat(2000)));
  await assert.rejects(h.run({ maxMessageBytes: 1000 }), error('sync_response_too_large'));
  assert.equal(h.snapshot.correspondence.messages.length, 0); assert.equal(h.snapshot.sync.cursor, null);
});

test('normalized batch cap and cache cap do not silently truncate acknowledged pages', async () => {
  const h = syncHarness(); h.gmailFull(); await assert.rejects(h.run({ maxBatchBytes: 10 }), error('sync_batch_limit'));
  assert.equal(h.commits, 0);
  const g = syncHarness(); g.gmailFull(); await g.run();
  g.add({ history: [{ messagesAdded: [{ message: { id: 'another' } }] }], historyId: '200' }); g.add(gmailMessage('another'));
  await assert.rejects(g.run({ maxRecords: 1 }), error('sync_cache_limit'));
  assert.equal(g.snapshot.sync.revision, 1); assert.equal(g.snapshot.correspondence.messages.length, 1);
});

test('oversized plaintext and unsupported MIME become persisted quarantine dispositions', async () => {
  const h = syncHarness(); h.gmailFull(gmailMessage('message-1', 'x'.repeat(101)));
  const result = await h.run({ maxTextBytes: 100 });
  assert.equal(result.ingested, 0); assert.equal(result.quarantined, 1);
  assert.equal(h.snapshot.sync.quarantine[0]!.reason, 'invalid-message'); assert.equal(h.snapshot.sync.revision, 1);
  const g = syncHarness(); const msg = gmailMessage();
  msg.payload.headers.push({ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' });
  g.gmailFull(msg); await g.run();
  assert.equal(g.snapshot.sync.quarantine[0]!.reason, 'unsupported-content');
  assert.match(g.snapshot.correspondence.messages[0]!.body, /quarantined/);
});

test('MIME tree depth, duplicate address headers and malformed encodings are quarantined', async () => {
  for (const mode of ['depth', 'headers', 'encoding']) {
    const h = syncHarness(); const message = gmailMessage();
    if (mode === 'headers') message.payload.headers.push({ name: 'From', value: 'other@example.org' });
    if (mode === 'encoding') message.payload.body.data = 'invalid%%%';
    if (mode === 'depth') {
      let part: unknown = message.payload;
      for (let depth = 0; depth < 12; depth++) part = { mimeType: 'multipart/mixed', parts: [part] };
      h.gmailFull({ ...message, payload: { ...(part as Record<string, unknown>), headers: message.payload.headers } });
    } else h.gmailFull(message);
    await h.run(); assert.equal(h.snapshot.sync.quarantine[0]!.reason, 'invalid-message', mode);
    assert.equal(h.snapshot.correspondence.messages.length, 0);
  }
});

test('Gmail profile and message IDs must match the requested mailbox/message', async () => {
  const h = syncHarness(); h.add({ emailAddress: 'foreign@example.org', historyId: '100' });
  await assert.rejects(h.run(), error('sync_account_mismatch')); assert.equal(h.requests.length, 1);
  const g = syncHarness(); g.add({ emailAddress: g.binding.address, historyId: '100' });
  g.add({ messages: [{ id: 'requested' }] }); g.add(gmailMessage('different'));
  await assert.rejects(g.run(), error('sync_message_mismatch')); assert.equal(g.commits, 0);
});

test('same provider ID from different accounts creates distinct unverified evidence', async () => {
  const h = syncHarness(); h.gmailFull(); await h.run();
  const nextState = transitionCorrespondence(h.snapshot.correspondence, h.domain.human, {
    type: 'connectMailbox', inputId: 'account-two', connection: { provider: 'gmail', accountRef: 'account-two',
      connectionRef: 'external-handle-two', address: 'second@alpha.example' },
  }).state;
  const binding: SyncBinding = { ...h.binding, accountRef: 'account-two', address: 'second@alpha.example',
    providerAccountId: 'second@alpha.example', authEpoch: nextState.mailbox.epochs.auth };
  h.setSnapshot({ correspondence: nextState, sync: createMailboxSyncState(binding) });
  const message = gmailMessage(); message.payload.headers.find(item => item.name === 'To')!.value = binding.address;
  const replies = [response({ emailAddress: binding.address, historyId: '100' }), response({ messages: [{ id: 'message-1' }] }), response(message)];
  const transport: ReadOnlyMailboxTransport = { binding, async read() { return replies.shift()!; } };
  await synchronizeMailbox({ binding, context: h.ctx, store: h.store, transport, limits: { maxPages: 1 } });
  assert.equal(h.snapshot.correspondence.messages.length, 2);
  assert.notEqual(h.snapshot.correspondence.messages[0]!.id, h.snapshot.correspondence.messages[1]!.id);
});

test('reconnect same account reuses evidence across a fresh epoch-bound checkpoint', async () => {
  const h = syncHarness(); h.gmailFull(); await h.run();
  const snapshot = structuredClone(h.snapshot);
  snapshot.correspondence = transitionCorrespondence(snapshot.correspondence, h.domain.human, { type: 'connectMailbox', inputId: 'reconnect',
    connection: { provider: 'gmail', accountRef: h.binding.accountRef, connectionRef: 'replacement-handle', address: h.binding.address } }).state;
  h.binding.authEpoch = snapshot.correspondence.mailbox.epochs.auth; h.transport.binding = { ...h.binding };
  snapshot.sync = createMailboxSyncState(h.binding); h.setSnapshot(snapshot); h.gmailFull();
  assert.equal((await h.run()).ingested, 0); assert.equal(h.snapshot.correspondence.messages.length, 1);
});

test('read errors do not leak provider bodies, headers or transport exception details', async () => {
  const h = syncHarness(); const marker = 'sensitive-runtime-detail';
  h.replies.push(() => { throw new Error(marker); });
  await assert.rejects(h.run(), err => {
    assert.doesNotMatch(String(err), new RegExp(marker)); return error('sync_transport_failed')(err);
  });
  for (const status of [301, 401, 403, 429, 500]) {
    const g = syncHarness(); g.add({ error: { message: marker } }, status);
    await assert.rejects(g.run(), err => { assert.doesNotMatch(String(err), new RegExp(marker)); return true; });
    assert.equal(g.requests.length, 1); assert.equal(g.commits, 0);
  }
  const g = syncHarness(); g.replies.push(() => ({ status: 200, body: (async function* () { throw new Error(marker); })() }));
  await assert.rejects(g.run(), err => { assert.doesNotMatch(String(err), new RegExp(marker)); return error('sync_transport_failed')(err); });
});

test('wall-time bound aborts a stalled read without advancing state', async () => {
  const h = syncHarness(); h.replies.push(() => new Promise(() => {}));
  await assert.rejects(h.run({ timeoutMs: 10 }), error('sync_timeout'));
  assert.equal(h.requests[0]!.signal!.aborted, true); assert.equal(h.commits, 0);
});

test('binding rejects undeclared credential fields and invalid resource paths', () => {
  const h = syncHarness();
  assert.throws(() => createMailboxSyncState({ ...h.binding, credential: 'not-a-real-credential' } as SyncBinding), error('sync_invalid_binding'));
  assert.throws(() => createMailboxSyncState({ ...h.binding, providerAccountId: '../other' }), error('sync_invalid_binding'));
});

test('polling is bounded even when provider pages keep arriving', async () => {
  const h = syncHarness(); h.gmailFull(gmailMessage('message-1'), 'next');
  h.add({ messages: [{ id: 'message-2' }], nextPageToken: 'third' }); h.add(gmailMessage('message-2'));
  const result = await h.run({ maxPages: 2 });
  assert.equal(result.pagesCommitted, 2); assert.equal(result.more, true); assert.equal(h.requests.length, 5);
});

test('empty-chunk streams cannot evade byte or wall-time bounds', async () => {
  const h = syncHarness(); let chunks = 0;
  h.replies.push(() => ({ status: 200, body: (async function* () {
    while (true) { chunks++; yield new Uint8Array(); }
  })() }));
  await assert.rejects(h.run(), error('sync_response_too_fragmented'));
  assert.equal(chunks, 4097); assert.equal(h.commits, 0);
});

test('changed transport identity between requests cannot consume a page', async () => {
  const h = syncHarness();
  h.add({ emailAddress: h.binding.address, historyId: '100' }, 200, () => { h.transport.binding = { ...h.binding, authEpoch: 999 }; });
  await assert.rejects(h.run(), error('sync_transport_failed'));
  assert.equal(h.requests.length, 1); assert.equal(h.commits, 0);
});

test('provider IDs cannot become URL dot segments', async () => {
  for (const id of ['.', '..']) {
    const h = syncHarness();
    h.add({ emailAddress: h.binding.address, historyId: '100' }); h.add({ messages: [{ id }] });
    await assert.rejects(h.run(), error('sync_invalid_response'));
    assert.equal(h.requests.length, 2); assert.equal(h.commits, 0);
  }
});

test('a changed sender or sent flag cannot bypass quarantine for existing reply evidence', async () => {
  const h = syncHarness(); h.gmailFull(); await h.run();
  const changed = gmailMessage('message-1', 'Changed content.', { labelIds: ['SENT'] });
  changed.payload.headers.find(header => header.name === 'From')!.value = h.binding.address;
  h.add({ history: [{ messages: [{ id: 'message-1' }] }], historyId: '200' }); h.add(changed);
  const result = await h.run();
  assert.equal(result.quarantined, 1);
  assert.equal(h.snapshot.sync.quarantine[0]!.reason, 'changed-evidence');
  assert.equal(h.snapshot.sync.records[0]!.message!.text, 'Please share more details.');
});
