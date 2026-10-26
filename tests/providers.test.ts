import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFakeProvider, createFakeProviderState, encodeRfc5322, gmailProtocolRequest, graphProtocolRequest,
  parseProviderSendResponse, reconcileProviderRecords } from '../src/index.ts';
import type { GatewayReconcileCommand } from '../src/index.ts';
import { harness, error, later, freshDraft, queue } from './helpers.ts';

for (const behavior of ['accept-then-timeout', 'timeout-before-accept'] as const) {
  test(`${behavior}: no new send after uncertainty, only read-only reconciliation`, () => {
    const h = harness(); const send = h.send();
    const fake = applyFakeProvider(createFakeProviderState(), send, behavior);
    assert.equal(fake.outcome.kind, 'unknown');
    h.step({ type: 'recordOutcome', intentId: send.intentId, handoffId: send.id, outcome: fake.outcome }, h.gateway);
    assert.equal(h.state.intents[0]!.status, 'uncertain');
    assert.throws(() => h.step({ type: 'prepareDispatch', intentId: send.intentId }, h.gateway), error('intent_not_pending'));
    assert.throws(() => h.step({ type: 'handoff', intentId: send.intentId, ticketId: 'old' }, h.gateway), error('dispatch_fenced'));
    // A new grant cannot bypass an unresolved recipient fence.
    h.step({ type: 'issueGrant', grant: { id: 'extra', mode: 'autonomous', actorIds: ['alpha-agent'],
      recipients: ['records@beta.example'], purpose: h.agent.purpose, notBefore: h.agent.now,
      expiresAt: '2030-01-03T00:00:00Z', maxSends: 1, maxFollowups: 1, cooldownMs: 86_400_000 } });
    freshDraft(h);
    assert.throws(() => queue(h, 'next', 'extra'), error('recipient_busy'));
    const reconciled = h.step({ type: 'requestReconciliation', intentId: send.intentId }, h.gateway);
    assert.equal(reconciled.gatewayCommands.length, 1);
    const command = reconciled.gatewayCommands[0] as GatewayReconcileCommand;
    assert.equal(command.kind, 'reconcile'); assert.equal(command.retryPolicy, 'read-only');
    const result = applyFakeProvider(fake.state, command);
    assert.equal(result.state.attempts[0]!.calls, 1);
    assert.equal(result.outcome.kind, behavior === 'accept-then-timeout' ? 'accepted' : 'unknown');
    h.step({ type: 'recordOutcome', intentId: send.intentId, handoffId: send.id, outcome: result.outcome }, h.gateway);
    assert.equal(h.state.intents[0]!.status, behavior === 'accept-then-timeout' ? 'accepted' : 'uncertain');
    assert.equal(h.state.messages.length, behavior === 'accept-then-timeout' ? 1 : 0);
  });
}

test('reconciliation is rate limited and account fenced; outcomes cannot contradict a terminal receipt', () => {
  const h = harness(); const send = h.send();
  h.step({ type: 'markUncertain', intentId: send.intentId, handoffId: send.id, reason: 'crash' }, h.gateway);
  h.step({ type: 'requestReconciliation', intentId: send.intentId }, h.gateway);
  assert.throws(() => h.step({ type: 'requestReconciliation', intentId: send.intentId }, h.gateway), error('reconciliation_cooldown'));
  assert.equal(h.step({ type: 'requestReconciliation', intentId: send.intentId }, later(h.gateway, 30_000)).gatewayCommands[0]!.kind, 'reconcile');
  h.step({ type: 'connectMailbox', connection: { provider: 'fake', accountRef: 'other', connectionRef: 'other', address: 'other@example.org' } }, later(h.human, 30_000));
  assert.throws(() => h.step({ type: 'requestReconciliation', intentId: send.intentId }, later(h.gateway, 60_000)), error('reconciliation_account_mismatch'));
  h.step({ type: 'recordOutcome', intentId: send.intentId, handoffId: send.id,
    outcome: { kind: 'accepted', providerMessageId: 'receipt' } }, later(h.gateway, 60_000));
  assert.throws(() => h.step({ type: 'recordOutcome', intentId: send.intentId, handoffId: send.id,
    outcome: { kind: 'rejected', code: 'not-accepted' } }, later(h.gateway, 60_000)), error('outcome_conflict'));
});

test('protocol plans preserve safe content and external credential handles without executing requests', () => {
  const h = harness(); const send = h.send();
  const gmail = gmailProtocolRequest({ ...send, provider: 'gmail' });
  assert.equal(gmail.method, 'POST'); assert.equal(gmail.retryPolicy, 'never-blind-retry');
  assert.equal(gmail.credentialHandle, 'alpha-credential-handle');
  assert.equal(gmail.expectedAuthEpoch, h.state.mailbox.epochs.auth);
  const raw = Buffer.from((gmail.body as { raw: string }).raw, 'base64url').toString('utf8');
  assert.equal(raw, encodeRfc5322(send));
  assert.match(raw, /Message-ID: <[a-f0-9]+@alpha.example>/);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  const graph = graphProtocolRequest({ ...send, provider: 'graph' });
  assert.equal(graph.method, 'POST'); assert.equal(graph.retryPolicy, 'never-blind-retry');
  assert.doesNotMatch(JSON.stringify(graph.headers), /Authorization|Bearer/);
  assert.throws(() => gmailProtocolRequest(send), error('provider_mismatch'));
  assert.throws(() => encodeRfc5322({ ...send, envelope: { ...send.envelope, to: 'reader@example.org\r\nBcc: hidden@example.org' } }), error('unsafe_header'));
});

test('RFC5322 serializes Unicode and quoted body safely without losing characters', () => {
  const send = harness().send();
  send.envelope.subject = '資料 📚 '.repeat(20).trim();
  send.envelope.body = 'First\n.Second\r\n資料 and 📚';
  const wire = encodeRfc5322(send);
  const [headers, body] = wire.split('\r\n\r\n');
  assert.equal(Buffer.from(body!, 'base64').toString('utf8'), 'First\r\n.Second\r\n資料 and 📚');
  const encoded = headers!.match(/=\?UTF-8\?B\?[^?]+\?=/g)!;
  assert.ok(encoded.every(word => word.length <= 75));
  assert.equal(encoded.map(word => Buffer.from(word.slice(10, -2), 'base64').toString('utf8')).join(''), send.envelope.subject);
});

test('response parser never treats malformed success, throttling or server errors as safe to retry', () => {
  assert.deepEqual(parseProviderSendResponse('gmail', 200, { id: 'receipt-1' }), { kind: 'accepted', providerMessageId: 'receipt-1' });
  assert.deepEqual(parseProviderSendResponse('graph', 202, null), { kind: 'accepted', providerMessageId: null });
  for (const provider of ['gmail', 'graph'] as const) {
    for (const status of [200, 400, 408, 429, 500, 503]) assert.equal(parseProviderSendResponse(provider, status, {}).kind, 'unknown');
    assert.deepEqual(parseProviderSendResponse(provider, 401, {}), { kind: 'rejected', code: 'auth-denied' });
    assert.deepEqual(parseProviderSendResponse(provider, 403, {}), { kind: 'rejected', code: 'policy-denied' });
  }
  assert.equal(parseProviderSendResponse('gmail', 200, { id: 'bad\nreceipt' }).kind, 'unknown');
});

test('search hits and ambiguous provider records remain uncertain; exact authenticated evidence resolves', () => {
  const h = harness(); const send = h.send();
  h.step({ type: 'markUncertain', intentId: send.intentId, handoffId: send.id, reason: 'transport' }, h.gateway);
  const command = h.step({ type: 'requestReconciliation', intentId: send.intentId }, h.gateway).gatewayCommands[0] as GatewayReconcileCommand;
  const gmail = { ...command, provider: 'gmail' as const };
  assert.equal(gmailProtocolRequest(gmail).method, 'GET');
  assert.equal(gmailProtocolRequest(gmail).retryPolicy, 'read-only');
  const record = { id: 'gmail-receipt', labelIds: ['SENT'], payload: { headers: [
    { name: 'Message-ID', value: command.messageId }, { name: 'X-Accountability-Handoff', value: command.handoffId },
  ] } };
  assert.equal(reconcileProviderRecords(gmail, [{ id: 'search-hit' }]).kind, 'unknown');
  assert.equal(reconcileProviderRecords(gmail, [{ ...record, labelIds: ['INBOX'] }]).kind, 'unknown');
  assert.equal(reconcileProviderRecords(gmail, [record]).kind, 'accepted');
  assert.equal(reconcileProviderRecords(gmail, [record, { ...record, id: 'duplicate-send' }]).kind, 'unknown');
  const graph = { ...command, provider: 'graph' as const };
  assert.equal(graphProtocolRequest(graph).method, 'GET');
  const graphRecord = { id: 'graph-receipt', sentDateTime: command.since,
    internetMessageHeaders: [{ name: 'x-accountability-handoff', value: command.handoffId }] };
  assert.equal(reconcileProviderRecords(graph, [graphRecord]).kind, 'accepted');
  assert.equal(reconcileProviderRecords(graph, [{ ...graphRecord, sentDateTime: '2000-01-01T00:00:00Z' }]).kind, 'unknown');
});
