import assert from 'node:assert/strict';
import { createAlphaCorrespondenceFixture, transitionCorrespondence } from '../src/index.ts';
import type { CorrespondenceCommand, CorrespondenceState, GatewaySendCommand } from '../src/index.ts';
import { DomainError } from '../src/contracts.ts';
import type { Context } from '../src/contracts.ts';

export type TestCommand = CorrespondenceCommand extends infer C ? C extends CorrespondenceCommand ? Omit<C, 'inputId'> : never : never;
export function harness(before: CorrespondenceCommand['type'] = 'recordOutcome') {
  const fixture = createAlphaCorrespondenceFixture();
  let state = fixture.initial;
  for (const step of fixture.steps) {
    if (step.command.type === before) break;
    state = transitionCorrespondence(state, step.context, step.command).state;
  }
  const human = fixture.steps[0]!.context;
  const agent = fixture.steps.find(step => step.context.actor.kind === 'agent')!.context;
  const gateway = fixture.steps.find(step => step.context.actor.kind === 'service')!.context;
  let sequence = 0;
  return {
    get state() { return state; },
    human, agent, gateway,
    setState(next: CorrespondenceState) { state = next; },
    step(command: TestCommand, ctx = human) {
      const result = transitionCorrespondence(state, ctx, { inputId: `test-${++sequence}`, ...command });
      state = result.state;
      return result;
    },
    send(): GatewaySendCommand { return structuredClone(state.intents[0]!.handoff!.command); },
  };
}
export function error(code: string) {
  return (value: unknown) => value instanceof DomainError && value.code === code;
}
export function later(ctx: Context, ms: number): Context {
  return { ...ctx, now: new Date(Date.parse(ctx.now) + ms).toISOString() };
}
export function freshDraft(h: ReturnType<typeof harness>, id = 'next', ctx = h.agent) {
  h.step({ type: 'createDraft', draftId: id, threadId: 'alpha-thread',
    content: { kind: 'research', topic: 'Availability', questions: ['Where are the records?'] } }, ctx);
}
export function queue(h: ReturnType<typeof harness>, id = 'next', grantId = 'alpha-grant', ctx = h.agent) {
  return h.step({ type: 'queueDraft', draftId: id, expectedVersion: 1, intentId: `intent-${id}`, grantId }, ctx);
}
export function accept(h: ReturnType<typeof harness>) {
  const send = h.send();
  h.step({ type: 'recordOutcome', intentId: send.intentId, handoffId: send.id,
    outcome: { kind: 'accepted', providerMessageId: 'fake-receipt' } }, h.gateway);
  assert.equal(h.state.messages[0]!.delivery, 'provider-accepted');
}
export function reply(h: ReturnType<typeof harness>, body = 'Please provide more details.', extra = {}) {
  return h.step({ type: 'ingestReply', threadId: 'alpha-thread', provider: 'fake', accountRef: 'alpha-account',
    authEpoch: h.state.mailbox.epochs.auth, providerMessageId: 'reply-1', from: 'records@beta.example',
    to: 'research@alpha.example', subject: 'Re: Record availability', body,
    headers: { messageId: '<reply-1@beta.example>', inReplyTo: null, references: [] }, ...extra }, h.gateway);
}
