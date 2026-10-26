import assert from 'node:assert/strict';
import test from 'node:test';
import { scoped, verifyAudit } from '@accountability/evidence/database';
import { synchronizeMailbox } from '../src/index.ts';
import type { ReadOnlyMailboxTransport } from '../src/index.ts';
import { gmailMessage, response } from './sync-helpers.ts';
import { setup, initialize, connect, binding, human, gateway, prepared, code } from './durable-helpers.ts';

function incomingTransport(target: ReturnType<typeof binding>, extra = {}) {
  const replies = [response({ emailAddress: target.address, historyId: '100' }), response({ messages: [{ id: 'reply-1' }] }), response(gmailMessage('reply-1', 'STOP', extra))];
  let reads = 0;
  const transport: ReadOnlyMailboxTransport = { binding: target, async read(request) {
    assert.equal(request.method, 'GET'); reads++; const result = replies.shift(); assert.ok(result); return result;
  } };
  return { transport, get reads() { return reads; } };
}

test('actual pinned migration, restricted login and scoped generic KV persist the aggregate', async t => {
  const rig = await setup(t); const initial = await initialize(rig.repo);
  assert.deepEqual(await rig.repo.load(human, 'mailbox'), initial);
  assert.equal((await rig.pg.query<{ name: string }>('SELECT current_user AS name')).rows[0]!.name, 'correspondence_test_login');
  const tables = await rig.pg.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='evidence_record'");
  assert.ok(tables.rows[0]!.relrowsecurity && tables.rows[0]!.relforcerowsecurity);
  await assert.rejects(rig.pg.query('SELECT * FROM public.evidence_record'), /permission denied/);
  const audits = await scoped(rig.db, human, tx => tx.audits()); assert.ok(verifyAudit(audits));
  assert.equal(audits[0]!.payload && (audits[0]!.payload as { kind: string }).kind, 'correspondence-mailbox-v1');
});

test('owner sessions and foreign scopes cannot load or update a mailbox', async t => {
  const owner = await setup(t, { restricted: false });
  await assert.rejects(initialize(owner.repo), code('unsafe_database_role'));
  const rig = await setup(t); await initialize(rig.repo);
  for (const scope of [{ ...human, tenantId: 'foreign' }, { ...human, projectId: 'foreign' }]) {
    await assert.rejects(rig.repo.load(scope, 'mailbox'), code('not_found'));
    await assert.rejects(rig.repo.execute(scope, 'mailbox', 0, { type: 'setControl', inputId: 'foreign', mode: 'autonomous' }), code('not_found'));
  }
  await assert.rejects(rig.repo.load({ ...human, actor: { ...human.actor, roles: [] } }, 'mailbox'), code('permission_denied'));
});

test('sync store commits cursor, unverified evidence and suppression in one durable record', async t => {
  const rig = await setup(t); await initialize(rig.repo); const state = await connect(rig.repo); const target = binding(state);
  const store = await rig.repo.openSyncStore(gateway, target); const fake = incomingTransport(target);
  const result = await synchronizeMailbox({ context: gateway, binding: target, store, transport: fake.transport, limits: { maxPages: 1 } });
  assert.equal(result.ingested, 1); const loaded = await store.load(target);
  assert.equal(loaded.sync.revision, 1); assert.equal(loaded.sync.cursor!.kind, 'gmail-history');
  assert.equal(loaded.correspondence.messages[0]!.delivery, 'received-unverified'); assert.equal(loaded.correspondence.suppressions[0]!.active, true);
  assert.deepEqual((await rig.repo.load(human, 'mailbox')).messages, loaded.correspondence.messages);
});

test('real record insert failure rolls back checkpoint, aggregate, head and audit together', async t => {
  const rig = await setup(t); await initialize(rig.repo); const state = await connect(rig.repo); const target = binding(state);
  const store = await rig.repo.openSyncStore(gateway, target); const before = await store.load(target);
  const audits = await scoped(rig.db, human, tx => tx.audits());
  const storedBefore = (await scoped(rig.db, human, tx => tx.list('correspondence-mailbox-v1')))[0]!;
  rig.fault.afterRecord = true;
  await assert.rejects(synchronizeMailbox({ context: gateway, binding: target, store, transport: incomingTransport(target).transport, limits: { maxPages: 1 } }), code('sync_commit_failed'));
  rig.fault.afterRecord = false;
  assert.deepEqual(await store.load(target), before);
  assert.deepEqual(await scoped(rig.db, human, tx => tx.audits()), audits);
  assert.equal(await scoped(rig.db, human, tx => tx.get(storedBefore.kind, storedBefore.id, storedBefore.revision + 1)), null);
  assert.equal((await synchronizeMailbox({ context: gateway, binding: target, store, transport: incomingTransport(target).transport, limits: { maxPages: 1 } })).ingested, 1);
});

test('both domain and checkpoint revisions reject stale commits and forged domain changes', async t => {
  const rig = await setup(t); await initialize(rig.repo); const state = await connect(rig.repo); const target = binding(state);
  const store = await rig.repo.openSyncStore(gateway, target); const before = await store.load(target);
  const next = structuredClone(before); next.sync.revision++;
  next.sync.cursor = { kind: 'gmail-history', historyId: '100', pageToken: null };
  const input = { binding: target, expectedSyncRevision: 0, expectedCorrespondenceRevision: state.revision, next };
  assert.equal(await store.commit(input), true);
  assert.equal(await store.commit(input), false);
  const current = await store.load(target); const tampered = structuredClone(current); tampered.sync.revision++;
  tampered.correspondence.mailbox.control = 'autonomous';
  await assert.rejects(store.commit({ binding: target, expectedSyncRevision: 1, expectedCorrespondenceRevision: state.revision, next: tampered }), code('invalid_sync_transition'));
  const afterControl = await rig.repo.execute(human, 'mailbox', state.revision, { type: 'setControl', inputId: 'takeover', mode: 'human' });
  const stale = structuredClone(current); stale.sync.revision++;
  assert.equal(await store.commit({ binding: target, expectedSyncRevision: 1, expectedCorrespondenceRevision: state.revision, next: stale }), false);
  assert.equal((await rig.repo.load(human, 'mailbox')).revision, afterControl.state.revision);
});

test('takeover vs ingress interleavings use the current aggregate and cannot restore autonomy', async t => {
  const rig = await setup(t); await initialize(rig.repo); let state = await connect(rig.repo);
  state = (await rig.repo.execute(human, 'mailbox', state.revision, { type: 'setControl', inputId: 'autonomous', mode: 'autonomous' })).state;
  const target = binding(state); const store = await rig.repo.openSyncStore(gateway, target);
  const fake = incomingTransport(target); const baseRead = fake.transport.read;
  fake.transport.read = async request => {
    const result = await baseRead(request);
    if (request.url.endsWith('/profile')) await rig.repo.execute(human, 'mailbox', state.revision, { type: 'setControl', inputId: 'human-takeover', mode: 'human' });
    return result;
  };
  await synchronizeMailbox({ context: gateway, binding: target, store, transport: fake.transport, limits: { maxPages: 1 } });
  const loaded = await rig.repo.load(human, 'mailbox'); assert.equal(loaded.mailbox.control, 'human');
  assert.equal(loaded.messages.length, 1); assert.equal(loaded.threads[0]!.autonomyPaused, true);
});

test('concurrent aggregate revisions have one winner on the embedded database connection', async t => {
  const rig = await setup(t); await initialize(rig.repo);
  const results = await Promise.allSettled([
    rig.repo.execute(human, 'mailbox', 0, { type: 'setResearchContext', inputId: 'writer-a', contextLabel: 'First' }),
    rig.repo.execute(human, 'mailbox', 0, { type: 'setResearchContext', inputId: 'writer-b', contextLabel: 'Second' }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failed = results.find(r => r.status === 'rejected'); assert.ok(failed && code('revision_conflict')(failed.reason));
  assert.equal((await rig.repo.load(human, 'mailbox')).revision, 1);
});

test('reconnect fences old store generations; a fresh epoch deduplicates provider evidence', async t => {
  const rig = await setup(t); await initialize(rig.repo); const state = await connect(rig.repo); const target = binding(state);
  const store = await rig.repo.openSyncStore(gateway, target);
  await synchronizeMailbox({ context: gateway, binding: target, store, transport: incomingTransport(target).transport, limits: { maxPages: 1 } });
  const current = await rig.repo.load(human, 'mailbox');
  const updated = await rig.repo.execute(human, 'mailbox', current.revision, { type: 'connectMailbox', inputId: 'reconnect', connection: {
    provider: 'gmail', accountRef: 'account', connectionRef: 'external-handle-new', address: target.address } });
  await assert.rejects(store.load(target), code('sync_fenced'));
  const freshTarget = binding(updated.state); const fresh = await rig.repo.openSyncStore(gateway, freshTarget);
  assert.equal((await synchronizeMailbox({ context: gateway, binding: freshTarget, store: fresh, transport: incomingTransport(freshTarget).transport,
    limits: { maxPages: 1 } })).ingested, 0);
  assert.equal((await rig.repo.load(human, 'mailbox')).messages.length, 1);
  await assert.rejects(fresh.load({ ...freshTarget, accountRef: 'wrong-account' }), code('sync_checkpoint_mismatch'));
});

test('takeover committed before handoff fences durable dispatch; rollback cannot release effects', async t => {
  const rig = await setup(t); const ready = await prepared(rig.repo);
  await rig.repo.execute(human, 'mailbox', ready.state.revision, { type: 'setControl', inputId: 'takeover', mode: 'human' });
  await assert.rejects(rig.repo.execute(gateway, 'mailbox', ready.state.revision, ready.handoff), code('revision_conflict'));
  const current = await rig.repo.load(human, 'mailbox'); assert.equal(current.intents[0]!.status, 'cancelled');
  const other = await setup(t); const pending = await prepared(other.repo); other.fault.beforeCommit = true;
  await assert.rejects(other.repo.execute(gateway, 'mailbox', pending.state.revision, pending.handoff), /before commit/);
  other.fault.beforeCommit = false;
  assert.equal((await other.repo.load(human, 'mailbox')).intents[0]!.handoff, null);
});

test('one-shot handoff consumption commits uncertainty before effects and rejects replay and stale handles', async t => {
  const rig = await setup(t); const ready = await prepared(rig.repo, 'handed-off'); assert.ok(ready.send);
  const handoffReplay = await rig.repo.execute(gateway, 'mailbox', ready.state.revision - 1, ready.handoff);
  assert.equal(handoffReplay.duplicate, true); assert.deepEqual(handoffReplay.gatewayCommands, []);
  const consumed = await rig.repo.consumeHandoff(gateway, 'mailbox', ready.send);
  assert.equal((await rig.repo.load(gateway, 'mailbox')).intents[0]!.status, 'uncertain');
  await assert.rejects(rig.repo.consumeHandoff(gateway, 'mailbox', ready.send), code('handoff_consumed'));
  await assert.rejects(rig.repo.recordHandoffOutcome(gateway, { ...consumed.consumption, generation: 2 }, { kind: 'accepted', providerMessageId: 'fake-receipt' }), code('stale_handoff_generation'));
  await rig.repo.recordHandoffOutcome(gateway, consumed.consumption, { kind: 'accepted', providerMessageId: 'fake-receipt' });
  const replayed = await rig.repo.recordHandoffOutcome(gateway, consumed.consumption, { kind: 'accepted', providerMessageId: 'fake-receipt' });
  assert.equal(replayed.duplicate, true); assert.equal((await rig.repo.load(human, 'mailbox')).messages.length, 1);
});

test('filesystem restart preserves cursor, ingress dedup, uncertain handoff consumption and no-resend state', async t => {
  const rig = await setup(t, { persistent: true }); await initialize(rig.repo); const state = await connect(rig.repo); const target = binding(state);
  const store = await rig.repo.openSyncStore(gateway, target);
  await synchronizeMailbox({ context: gateway, binding: target, store, transport: incomingTransport(target).transport, limits: { maxPages: 1 } });
  const before = await store.load(target); await rig.restart();
  const reopened = await rig.repo.openSyncStore(gateway, target); assert.deepEqual(await reopened.load(target), before);
  const replayPages = [response({ history: [{ messages: [{ id: 'reply-1' }] }], historyId: '200' }), response(gmailMessage('reply-1', 'STOP'))];
  const replay: ReadOnlyMailboxTransport = { binding: target, async read() { const page = replayPages.shift(); assert.ok(page); return page; } };
  assert.equal((await synchronizeMailbox({ context: gateway, binding: target, store: reopened, transport: replay, limits: { maxPages: 1 } })).ingested, 0);
  assert.equal((await rig.repo.load(human, 'mailbox')).messages.length, 1);
  const handoffs = await setup(t, { persistent: true }); const ready = await prepared(handoffs.repo, 'handed-off'); assert.ok(ready.send);
  await handoffs.repo.consumeHandoff(gateway, 'mailbox', ready.send); await handoffs.restart();
  await assert.rejects(handoffs.repo.consumeHandoff(gateway, 'mailbox', ready.send), code('handoff_consumed'));
  const uncertain = await handoffs.repo.load(gateway, 'mailbox'); assert.equal(uncertain.intents[0]!.status, 'uncertain');
  await assert.rejects(handoffs.repo.execute(gateway, 'mailbox', uncertain.revision,
    { type: 'prepareDispatch', inputId: 'never-resend', intentId: 'intent' }), code('intent_not_pending'));
  const reconciliation = await handoffs.repo.execute(gateway, 'mailbox', uncertain.revision,
    { type: 'requestReconciliation', inputId: 'read-only-recovery', intentId: 'intent' });
  assert.equal(reconciliation.gatewayCommands[0]!.kind, 'reconcile');
  assert.equal(reconciliation.gatewayCommands[0]!.retryPolicy, 'read-only');
});

test('concurrent checkpoint writers and explicit generation supersession are fenced', async t => {
  const rig = await setup(t); await initialize(rig.repo); const state = await connect(rig.repo); const target = binding(state);
  const store = await rig.repo.openSyncStore(gateway, target); const current = await store.load(target);
  const next = structuredClone(current); next.sync.revision++;
  const input = { binding: target, expectedSyncRevision: 0, expectedCorrespondenceRevision: state.revision, next };
  const outcomes = await Promise.all([store.commit(input), store.commit(input)]);
  assert.equal(outcomes.filter(Boolean).length, 1); assert.equal((await store.load(target)).sync.revision, 1);
  // A storage-administration operation supersedes the slot generation without changing its domain revision.
  await scoped(rig.db, human, async tx => {
    const records = await tx.list<{ slots: Record<string, { generation: number }> }>('correspondence-mailbox-v1');
    const row = records[0]!; Object.values(row.value.slots)[0]!.generation++;
    await tx.put(row.kind, row.id, row.revision, row.value);
  });
  await assert.rejects(store.load(target), code('stale_sync_generation'));
});

test('lost consumption acknowledgement never releases a second execution permission', async t => {
  const rig = await setup(t); const ready = await prepared(rig.repo, 'handed-off'); assert.ok(ready.send);
  rig.fault.afterCommit = true;
  await assert.rejects(rig.repo.consumeHandoff(gateway, 'mailbox', ready.send), /lost commit acknowledgement/);
  rig.fault.afterCommit = false;
  assert.equal((await rig.repo.load(gateway, 'mailbox')).intents[0]!.status, 'uncertain');
  await assert.rejects(rig.repo.consumeHandoff(gateway, 'mailbox', ready.send), code('handoff_consumed'));
});

test('command replay uses persisted receipts without repeating a write or emitting effects', async t => {
  const rig = await setup(t); await initialize(rig.repo);
  const command = { type: 'setControl' as const, inputId: 'once', mode: 'autonomous' as const };
  const first = await rig.repo.execute(human, 'mailbox', 0, command);
  const beforeAudits = await scoped(rig.db, human, tx => tx.audits());
  const replayed = await rig.repo.execute(human, 'mailbox', 0, command);
  assert.equal(replayed.duplicate, true); assert.equal(replayed.state.revision, first.state.revision);
  assert.deepEqual(replayed.gatewayCommands, []);
  assert.deepEqual(await scoped(rig.db, human, tx => tx.audits()), beforeAudits);
  await assert.rejects(rig.repo.execute(human, 'mailbox', 0, { ...command, mode: 'human' }), code('input_id_conflict'));
});
