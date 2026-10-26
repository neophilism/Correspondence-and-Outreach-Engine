import type { Context } from './contracts.ts';
import type { CorrespondenceCommand, CorrespondenceState, GatewayCommand } from './types.ts';
import { createCorrespondenceState, transitionCorrespondence } from './machine.ts';
import { applyFakeProvider, createFakeProviderState } from './adapters.ts';
import type { FakeProviderState } from './adapters.ts';

/** Entirely fictional, deterministic integration fixture. Nothing is sent, persisted, or connected. */
export function createAlphaCorrespondenceFixture(): {
  initial: CorrespondenceState; steps: { context: Context; command: CorrespondenceCommand }[];
  state: CorrespondenceState; gatewayCommands: GatewayCommand[]; providerState: FakeProviderState;
} {
  const base = { tenantId: 'alpha', projectId: 'beta', purpose: 'research-outreach', now: '2030-01-01T00:00:00.000Z' };
  const human: Context = { ...base, requestId: 'alpha-create', actor: { id: 'alpha-human', kind: 'human',
    roles: ['correspondence:read', 'correspondence:write', 'correspondence:control', 'correspondence:authorize'] } };
  const agent: Context = { ...base, requestId: 'alpha-agent', actor: { id: 'alpha-agent', kind: 'agent', roles: ['correspondence:write'] } };
  const gateway: Context = { ...base, requestId: 'alpha-gateway', actor: { id: 'alpha-gateway', kind: 'service',
    roles: ['correspondence:gateway', 'correspondence:ingress'] } };
  const initial = createCorrespondenceState(human, { mailboxId: 'alpha-mailbox', brand: 'Alpha Research' });
  let state = initial;
  const steps: { context: Context; command: CorrespondenceCommand }[] = [];
  const gatewayCommands: GatewayCommand[] = [];
  function step(context: Context, command: CorrespondenceCommand) {
    const result = transitionCorrespondence(state, context, command);
    steps.push({ context: structuredClone(context), command: structuredClone(command) });
    state = result.state; gatewayCommands.push(...result.gatewayCommands); return result;
  }
  step(human, { type: 'connectMailbox', inputId: 'alpha-connect', connection: { provider: 'fake', accountRef: 'alpha-account',
    connectionRef: 'alpha-credential-handle', address: 'research@alpha.example' } });
  step(human, { type: 'setControl', inputId: 'alpha-control', mode: 'autonomous' });
  step(human, { type: 'issueGrant', inputId: 'alpha-grant', grant: { id: 'alpha-grant', mode: 'autonomous', actorIds: ['alpha-agent'],
    recipients: ['records@beta.example'], purpose: base.purpose, notBefore: base.now, expiresAt: '2030-01-02T00:00:00.000Z',
    maxSends: 1, maxFollowups: 0, cooldownMs: 86_400_000 } });
  step(agent, { type: 'createThread', inputId: 'alpha-thread', threadId: 'alpha-thread', recipient: 'records@beta.example', subject: 'Record availability' });
  step(agent, { type: 'createDraft', inputId: 'alpha-draft', draftId: 'alpha-draft', threadId: 'alpha-thread',
    content: { kind: 'research', topic: 'Record availability', questions: ['Which records are publicly available?', 'Where can we find the publication schedule?'] } });
  step(agent, { type: 'queueDraft', inputId: 'alpha-queue', draftId: 'alpha-draft', expectedVersion: 1, intentId: 'alpha-intent', grantId: 'alpha-grant' });
  const prepared = step(gateway, { type: 'prepareDispatch', inputId: 'alpha-prepare', intentId: 'alpha-intent' });
  const handed = step(gateway, { type: 'handoff', inputId: 'alpha-handoff', intentId: 'alpha-intent', ticketId: prepared.result.ticketId! });
  const send = handed.gatewayCommands[0]!;
  const simulated = applyFakeProvider(createFakeProviderState(), send);
  step(gateway, { type: 'recordOutcome', inputId: 'alpha-outcome', intentId: 'alpha-intent', handoffId: send.id, outcome: simulated.outcome });
  step(gateway, { type: 'ingestReply', inputId: 'alpha-reply', threadId: 'alpha-thread', provider: 'fake', accountRef: 'alpha-account',
    authEpoch: state.mailbox.epochs.auth, providerMessageId: 'beta-reply-1', from: 'records@beta.example', to: 'research@alpha.example',
    subject: 'Re: Record availability', body: 'STOP', headers: { messageId: '<beta-reply-1@beta.example>', inReplyTo: null, references: [] } });
  return { initial, steps, state, gatewayCommands, providerState: simulated.state };
}
