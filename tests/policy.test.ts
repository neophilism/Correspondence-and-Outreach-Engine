import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, error, later, freshDraft, queue, accept, reply } from './helpers.ts';
import type { GrantInput } from '../src/index.ts';

function grant(h: ReturnType<typeof harness>, overrides: Partial<GrantInput> = {}, ctx = h.human) {
  return h.step({ type: 'issueGrant', grant: { id: 'new-grant', mode: 'autonomous', actorIds: ['alpha-agent'],
    recipients: ['records@beta.example'], purpose: h.agent.purpose, notBefore: h.human.now,
    expiresAt: '2030-01-10T00:00:00Z', maxSends: 2, maxFollowups: 1, cooldownMs: 86_400_000,
    ...overrides } }, ctx);
}

test('grant issuer must be human and grant limits cannot bypass mailbox ceilings', () => {
  const h = harness('queueDraft');
  assert.throws(() => grant(h, {}, h.agent), error('actor_denied'));
  for (const overrides of [{ maxSends: 26 }, { maxSends: 1.5 }, { maxFollowups: 3 }, { cooldownMs: 1 }]) {
    assert.throws(() => grant(h, overrides), error('invalid_limit'));
  }
  assert.throws(() => grant(h, { expiresAt: '2031-01-01T00:00:00Z' }), error('invalid_grant_time'));
  assert.throws(() => grant(h, { expiresAt: h.human.now }), error('invalid_grant_time'));
  assert.throws(() => grant(h, { mode: 'human' }), error('control_denied'));
  assert.throws(() => grant(h, { recipients: [] }), error('invalid_grant'));
});

test('grant binds exact recipient, actor, purpose, active interval and current epochs', () => {
  const cases: [Partial<GrantInput>, string][] = [
    [{ recipients: ['another@example.org'] }, 'grant_denied'],
    [{ actorIds: ['other-agent'] }, 'grant_denied'],
    [{ purpose: 'unrelated-purpose' }, 'grant_denied'],
    [{ notBefore: '2030-01-02T00:00:00Z' }, 'grant_expired'],
  ];
  for (const [overrides, code] of cases) {
    const h = harness('queueDraft'); grant(h, overrides);
    assert.throws(() => queue(h, 'alpha-draft', 'new-grant'), error(code));
  }
  const h = harness('queueDraft');
  assert.throws(() => queue(h, 'alpha-draft', 'alpha-grant', later(h.agent, 86_400_000)), error('grant_expired'));
  h.step({ type: 'setResearchContext', contextLabel: 'New research' });
  assert.throws(() => queue(h, 'alpha-draft'), error('stale_draft'));
  freshDraft(h);
  assert.throws(() => queue(h), error('grant_inactive'));
});

test('queued reservations consume grant budget across recipients without charging until handoff', () => {
  const h = harness('queueDraft');
  grant(h, { maxSends: 1, recipients: ['records@beta.example', 'another@example.org'] });
  queue(h, 'alpha-draft', 'new-grant');
  h.step({ type: 'createThread', threadId: 'other', recipient: 'another@example.org', subject: 'Other' }, h.agent);
  h.step({ type: 'createDraft', draftId: 'other', threadId: 'other', content: { kind: 'research', topic: 'Other', questions: ['Where?'] } }, h.agent);
  assert.throws(() => queue(h, 'other', 'new-grant'), error('grant_exhausted'));
  assert.equal(h.state.grants[1]!.usedSends, 0);
  h.step({ type: 'cancelIntent', intentId: 'intent-alpha-draft' }, h.agent);
  assert.equal(queue(h, 'other', 'new-grant').result.status, 'queued');
});

test('handoff budget is charged once, including unknown provider outcomes', () => {
  const h = harness();
  assert.equal(h.state.grants[0]!.usedSends, 1);
  freshDraft(h);
  assert.throws(() => queue(h), error('grant_exhausted'));
  const send = h.send();
  h.step({ type: 'markUncertain', intentId: send.intentId, handoffId: send.id, reason: 'timeout' }, h.gateway);
  assert.equal(h.state.grants[0]!.usedSends, 1);
});

test('followup ceiling and mailbox cooldown persist across grants', () => {
  const h = harness(); accept(h); freshDraft(h);
  grant(h, { maxFollowups: 0 });
  assert.throws(() => queue(h, 'next', 'new-grant', later(h.agent, 86_400_000)), error('followup_limit'));
  grant(h, { id: 'followup', maxFollowups: 1 });
  assert.throws(() => queue(h, 'next', 'followup'), error('cooldown_active'));
  assert.equal(queue(h, 'next', 'followup', later(h.agent, 86_400_000)).result.status, 'queued');
});

test('optout normalizes identity, cancels prepared send, and requires human consent to lift', () => {
  const h = harness('handoff');
  const received = reply(h, 'STOP\nPlease remove me.', { from: 'RECORDS@BETA.EXAMPLE' });
  assert.deepEqual(received.result.cancelledIntentIds, ['alpha-intent']);
  assert.equal(h.state.suppressions[0]!.address, 'records@beta.example');
  assert.equal(h.state.suppressions[0]!.active, true);
  freshDraft(h);
  assert.throws(() => queue(h), error('recipient_suppressed'));
  assert.throws(() => h.step({ type: 'liftSuppression', address: 'records@beta.example', consentNote: 'They opted in again.' }, h.agent), error('actor_denied'));
  assert.throws(() => h.step({ type: 'liftSuppression', address: 'records@beta.example', consentNote: '' }), error('invalid_input'));
  h.step({ type: 'liftSuppression', address: 'RECORDS@BETA.EXAMPLE', consentNote: 'Fictional consent recorded by human.' });
  assert.equal(h.state.suppressions[0]!.active, false);
  assert.equal(h.state.threads[0]!.autonomyPaused, true);
});

test('unsolicited reply pauses contact even after a human issues a fresh grant', () => {
  const h = harness('handoff'); reply(h);
  freshDraft(h); grant(h);
  assert.throws(() => queue(h, 'next', 'new-grant'), error('thread_paused'));
  h.step({ type: 'resumeThread', threadId: 'alpha-thread' });
  assert.throws(() => queue(h, 'next', 'new-grant'), error('stale_draft'));
});

test('late auth denial for old connection cannot disconnect a replacement account', () => {
  const h = harness(); const send = h.send();
  h.step({ type: 'connectMailbox', connection: { provider: 'fake', accountRef: 'replacement', connectionRef: 'new-handle', address: 'new@example.org' } });
  h.step({ type: 'recordOutcome', intentId: send.intentId, handoffId: send.id,
    outcome: { kind: 'rejected', code: 'auth-denied' } }, h.gateway);
  assert.equal(h.state.mailbox.connection!.accountRef, 'replacement');
});
