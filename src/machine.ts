import { digest, invariant, nonempty, requireScope, validTime } from './contracts.ts';
import type { Context, Scope } from './contracts.ts';
import type {
  CorrespondenceCommand, CorrespondenceResult, CorrespondenceRole, CorrespondenceState, CorrespondenceTransition,
  DispatchFence, Epochs, GatewayCommand, GatewaySendCommand, GrantInput, MailDraft, MailboxConnection,
  MailboxLimits, MailThread, OutboundIntent, ProviderOutcome, SendGrant,
} from './types.ts';
import { detectsOptOut, identifier, isoTime, normalizeAddress, provider, providerIdentifier, renderContent,
  renderResearchInquiry, safeBody, safeHeader, validateMessageHeaders } from './validation.ts';

export const DEFAULT_MAILBOX_LIMITS: Readonly<MailboxLimits> = Object.freeze({
  minimumCooldownMs: 86_400_000, maxFollowups: 2, maxGrantSends: 25, maxGrantLifetimeMs: 30 * 86_400_000,
});

function scopeOf(state: Scope): Scope { return { tenantId: state.tenantId, projectId: state.projectId }; }
function find<T extends { id: string }>(items: T[], id: string, label: string): T {
  const found = items.find(item => item.id === id);
  invariant(found, 'not_found', `${label} was not found`);
  return found;
}
function unique(items: { id: string }[], id: string): void {
  identifier(id);
  invariant(!items.some(item => item.id === id), 'duplicate_id', 'Identifier is already in use');
}
function role(ctx: Context, required: CorrespondenceRole, kind?: Context['actor']['kind']): void {
  invariant(!kind || ctx.actor.kind === kind, 'actor_denied', 'Actor kind is not permitted');
  invariant(ctx.actor.roles.includes(required) || (ctx.actor.kind === 'human' && ctx.actor.roles.includes('correspondence:admin')),
    'permission_denied', 'Correspondence permission is required');
}
function validateContext(ctx: Context): string {
  identifier(ctx.tenantId, 'Tenant'); identifier(ctx.projectId, 'Project'); identifier(ctx.actor.id, 'Actor');
  identifier(ctx.requestId, 'Request'); nonempty(ctx.purpose, 'Purpose', 200);
  invariant(['human', 'agent', 'service'].includes(ctx.actor.kind), 'actor_denied', 'Unknown actor kind');
  return isoTime(ctx.now);
}
function authorizeCommand(ctx: Context, command: CorrespondenceCommand): void {
  switch (command.type) {
    case 'connectMailbox': case 'disconnectMailbox': case 'issueGrant': case 'revokeGrant':
    case 'liftSuppression': case 'resumeThread': role(ctx, 'correspondence:authorize', 'human'); break;
    case 'setControl': case 'setResearchContext': case 'suppressRecipient': role(ctx, 'correspondence:control', 'human'); break;
    case 'prepareDispatch': case 'handoff': case 'markUncertain': case 'recordOutcome': case 'requestReconciliation':
      role(ctx, 'correspondence:gateway', 'service'); break;
    case 'ingestReply': role(ctx, 'correspondence:ingress', 'service'); break;
    case 'setThreadFlags': role(ctx, 'correspondence:write', 'human'); break;
    case 'createThread': case 'createDraft': case 'reviseDraft': case 'discardDraft': case 'queueDraft': case 'cancelIntent':
      role(ctx, 'correspondence:write');
      invariant(ctx.actor.kind !== 'service', 'actor_denied', 'Drafting and approval require a human or agent'); break;
    default: invariant(false, 'unknown_command', 'Unknown correspondence command');
  }
}
function integer(value: number, min: number, max: number, label: string): void {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid_limit', `${label} is outside its bounds`);
}
function sameEpochs(a: Epochs, b: Epochs): boolean {
  return a.control === b.control && a.context === b.context && a.auth === b.auth && a.suppression === b.suppression;
}
function pending(intent: OutboundIntent): boolean { return intent.status === 'queued' || intent.status === 'prepared'; }
function unresolved(intent: OutboundIntent): boolean { return intent.status === 'handed-off' || intent.status === 'uncertain'; }
function draftDigest(draft: MailDraft): string {
  return digest({ id: draft.id, version: draft.version, content: draft.content, subject: draft.subject, body: draft.body });
}
function fenceFor(state: CorrespondenceState, draft: MailDraft, grantId: string): DispatchFence {
  return { ...state.mailbox.epochs, threadContextEpoch: find(state.threads, draft.threadId, 'Thread').contextEpoch,
    draftVersion: draft.version, grantId };
}
function requireFreshDraft(state: CorrespondenceState, draft: MailDraft): MailThread {
  const thread = find(state.threads, draft.threadId, 'Thread');
  invariant(sameEpochs(draft.epochs, state.mailbox.epochs) && draft.threadContextEpoch === thread.contextEpoch,
    'stale_draft', 'Draft must be reviewed or regenerated against the current epochs');
  return thread;
}
function resultFor(id: string, status: string): CorrespondenceResult {
  return { entityId: id, status, ticketId: null, duplicateEvidence: false, cancelledIntentIds: [], unrecallableIntentIds: [] };
}
function cancelPending(state: CorrespondenceState, result: CorrespondenceResult, reason: string,
  matches: (intent: OutboundIntent) => boolean = () => true): void {
  for (const intent of state.intents.filter(matches)) {
    if (pending(intent)) {
      intent.status = 'cancelled'; intent.cancellationReason = reason; intent.ticket = null;
      const draft = find(state.drafts, intent.draftId, 'Draft');
      if (draft.status === 'queued') draft.status = 'draft';
      result.cancelledIntentIds.push(intent.id);
    } else if (unresolved(intent)) {
      result.unrecallableIntentIds.push(intent.id);
    }
  }
}
function bump(state: CorrespondenceState, epoch: keyof Epochs, result: CorrespondenceResult, reason: string): void {
  state.mailbox.epochs[epoch] += 1;
  cancelPending(state, result, reason);
}
function suppress(state: CorrespondenceState, ctx: Context, address: string,
  reason: 'manual' | 'opt-out' | 'invalid-recipient', result: CorrespondenceResult): void {
  const existing = state.suppressions.find(item => item.address === address && item.active);
  if (existing) return;
  state.suppressions.push({ address, reason, active: true, recordedAt: state.updatedAt, recordedBy: ctx.actor.id,
    liftedAt: null, consentNote: null });
  bump(state, 'suppression', result, 'suppression-changed');
}
function validateGrant(state: CorrespondenceState, ctx: Context, input: GrantInput): SendGrant {
  unique(state.grants, input.id);
  invariant(state.mailbox.connection, 'mailbox_disconnected', 'Connect the mailbox before issuing a grant');
  invariant(['human', 'autonomous'].includes(input.mode) && input.mode === state.mailbox.control,
    'control_denied', 'Grant mode must match current mailbox control');
  invariant(Array.isArray(input.actorIds) && input.actorIds.length >= 1 && input.actorIds.length <= 10,
    'invalid_grant', 'Grant requires a bounded actor list');
  invariant(Array.isArray(input.recipients) && input.recipients.length >= 1 && input.recipients.length <= 25,
    'invalid_grant', 'Grant requires a bounded recipient list');
  const actorIds = [...new Set(input.actorIds.map(value => identifier(value, 'Granted actor')))];
  const recipients = [...new Set(input.recipients.map(normalizeAddress))];
  nonempty(input.purpose, 'Grant purpose', 200);
  const notBefore = isoTime(input.notBefore); const expiresAt = isoTime(input.expiresAt);
  const start = validTime(notBefore); const end = validTime(expiresAt); const now = validTime(ctx.now);
  invariant(end > now && end > start && end - start <= state.mailbox.limits.maxGrantLifetimeMs
    && end - now <= state.mailbox.limits.maxGrantLifetimeMs, 'invalid_grant_time', 'Grant must have a bounded, future expiry');
  integer(input.maxSends, 1, state.mailbox.limits.maxGrantSends, 'Send budget');
  integer(input.maxFollowups, 0, state.mailbox.limits.maxFollowups, 'Followup budget');
  integer(input.cooldownMs, state.mailbox.limits.minimumCooldownMs, 90 * 86_400_000, 'Cooldown');
  return { ...scopeOf(state), id: input.id, mailboxId: state.mailbox.id, mode: input.mode, actorIds, recipients,
    purpose: input.purpose, notBefore, expiresAt, maxSends: input.maxSends, maxFollowups: input.maxFollowups,
    cooldownMs: input.cooldownMs, epochs: { ...state.mailbox.epochs }, issuedBy: ctx.actor.id,
    issuedAt: state.updatedAt, status: 'active', usedSends: 0 };
}
function maySend(state: CorrespondenceState, ctx: Context, intent: OutboundIntent): { draft: MailDraft; grant: SendGrant; thread: MailThread; connection: MailboxConnection } {
  const connection = state.mailbox.connection;
  invariant(connection, 'mailbox_disconnected', 'Mailbox is disconnected');
  const draft = find(state.drafts, intent.draftId, 'Draft');
  const thread = requireFreshDraft(state, draft);
  invariant(draft.version === intent.draftVersion && draftDigest(draft) === intent.draftDigest,
    'stale_draft', 'Draft content has changed since approval');
  invariant(digest(fenceFor(state, draft, intent.grantId)) === digest(intent.fence), 'stale_fence', 'Dispatch fence is stale');
  invariant(!state.suppressions.some(item => item.active && item.address === intent.recipient), 'recipient_suppressed', 'Recipient is suppressed');
  invariant(thread.folder !== 'trash' && thread.folder !== 'spam', 'thread_inactive', 'Inactive threads cannot send');
  invariant(intent.mode === state.mailbox.control, 'control_denied', 'Mailbox control changed');
  if (intent.mode === 'autonomous') {
    invariant(draft.content.kind === 'research' && draft.authorKind === 'agent' && draft.authorId === intent.actorId,
      'autonomous_content_denied', 'Autonomous sends require the agent’s structured research draft');
    invariant(!thread.autonomyPaused, 'thread_paused', 'A reply pauses autonomous contact until a human resumes it');
  }
  const grant = find(state.grants, intent.grantId, 'Send grant');
  requireScope(state, grant);
  invariant(grant.mailboxId === state.mailbox.id && grant.status === 'active' && sameEpochs(grant.epochs, state.mailbox.epochs),
    'grant_inactive', 'Send grant is revoked or bound to old epochs');
  invariant(grant.mode === intent.mode && grant.actorIds.includes(intent.actorId) && grant.recipients.includes(intent.recipient)
    && grant.purpose === intent.purpose && ctx.purpose === intent.purpose, 'grant_denied', 'Send is outside the grant');
  const now = validTime(ctx.now);
  invariant(now >= validTime(grant.notBefore) && now < validTime(grant.expiresAt), 'grant_expired', 'Send grant is not currently active');
  const reservations = state.intents.filter(other => other.id !== intent.id && other.grantId === grant.id && pending(other)).length;
  invariant(grant.usedSends + reservations < grant.maxSends, 'grant_exhausted', 'Send budget is exhausted or reserved');
  const others = state.intents.filter(other => other.id !== intent.id && other.recipient === intent.recipient);
  invariant(!others.some(other => pending(other) || unresolved(other)), 'recipient_busy', 'Recipient already has a pending or uncertain send');
  const attempts = others.filter(other => other.handoff !== null);
  if (intent.mode === 'autonomous') {
    invariant(attempts.length <= grant.maxFollowups, 'followup_limit', 'Recipient followup budget is exhausted');
  }
  for (const attempt of attempts) {
    invariant(now - validTime(attempt.handoff!.at) >= grant.cooldownMs, 'cooldown_active', 'Recipient cooldown has not elapsed');
  }
  return { draft, grant, thread, connection };
}

/** Pure aggregate constructor: no grant, no connection, human control, and no outbound effects. */
export function createCorrespondenceState(ctx: Context, input: {
  mailboxId: string; brand?: string; contextLabel?: string; limits?: Partial<MailboxLimits>;
}): CorrespondenceState {
  const now = validateContext(ctx); role(ctx, 'correspondence:control', 'human');
  identifier(input.mailboxId, 'Mailbox');
  const brand = input.brand ?? 'Correspondence Engine';
  renderResearchInquiry({ brand, topic: 'Research', questions: ['Which records are available?'] });
  const contextLabel = safeHeader(input.contextLabel ?? 'Research correspondence', 'Research context');
  const limits = { ...DEFAULT_MAILBOX_LIMITS, ...input.limits };
  integer(limits.minimumCooldownMs, 60_000, 90 * 86_400_000, 'Minimum cooldown');
  integer(limits.maxFollowups, 0, 3, 'Maximum followups');
  integer(limits.maxGrantSends, 1, 100, 'Maximum grant sends');
  integer(limits.maxGrantLifetimeMs, 60_000, 30 * 86_400_000, 'Maximum grant lifetime');
  return { ...scopeOf(ctx), schemaVersion: 1, revision: 0, createdAt: now, updatedAt: now,
    mailbox: { id: input.mailboxId, brand: brand.trim(), contextLabel, control: 'human',
      epochs: { control: 0, context: 0, auth: 0, suppression: 0 }, connection: null, limits },
    threads: [], drafts: [], messages: [], grants: [], suppressions: [], intents: [], receipts: [], events: [] };
}

/** Persist state with a revision compare-and-swap BEFORE releasing gatewayCommands. Replays emit no effects. */
export function transitionCorrespondence(original: CorrespondenceState, ctx: Context, command: CorrespondenceCommand): CorrespondenceTransition {
  requireScope(ctx, original);
  const now = validateContext(ctx); authorizeCommand(ctx, command); identifier(command.inputId, 'Input');
  const fingerprint = digest({ command, actorId: ctx.actor.id, actorKind: ctx.actor.kind, purpose: ctx.purpose });
  const previous = original.receipts.find(receipt => receipt.inputId === command.inputId);
  if (previous) {
    invariant(previous.fingerprint === fingerprint, 'input_id_conflict', 'Input ID was already used for different content or authority');
    return { state: original, result: structuredClone(previous.result), gatewayCommands: [], duplicate: true };
  }
  invariant(validTime(now) >= validTime(original.updatedAt), 'clock_reversed', 'Command time precedes the aggregate clock');
  const state = structuredClone(original);
  state.updatedAt = now; state.revision += 1;
  let result = resultFor(state.mailbox.id, command.type);
  const gatewayCommands: GatewayCommand[] = [];
  switch (command.type) {
    case 'createThread': {
      unique(state.threads, command.threadId);
      state.threads.push({ id: command.threadId, recipient: normalizeAddress(command.recipient),
        subject: safeHeader(command.subject, 'Subject'), folder: 'archive', read: true, starred: false,
        contextEpoch: 0, autonomyPaused: false, createdAt: now, lastActivityAt: now });
      result = resultFor(command.threadId, 'created'); break;
    }
    case 'createDraft': {
      unique(state.drafts, command.draftId);
      const thread = find(state.threads, command.threadId, 'Thread');
      invariant(ctx.actor.kind === 'human' || command.content.kind === 'research', 'autonomous_content_denied', 'Agents draft structured research inquiries only');
      const rendered = renderContent(state.mailbox.brand, command.content);
      state.drafts.push({ id: command.draftId, threadId: thread.id, version: 1, authorId: ctx.actor.id,
        authorKind: ctx.actor.kind, content: structuredClone(command.content), ...rendered,
        epochs: { ...state.mailbox.epochs }, threadContextEpoch: thread.contextEpoch, status: 'draft', createdAt: now, updatedAt: now });
      thread.lastActivityAt = now; result = resultFor(command.draftId, 'draft'); break;
    }
    case 'reviseDraft': case 'discardDraft': {
      const draft = find(state.drafts, command.draftId, 'Draft');
      invariant(draft.version === command.expectedVersion, 'stale_version', 'Draft revision does not match');
      invariant(ctx.actor.kind === 'human' || draft.authorId === ctx.actor.id, 'draft_owner_denied', 'Agent cannot edit another author’s draft');
      invariant(['draft', 'queued'].includes(draft.status), 'draft_locked', 'Handed-off, accepted, or discarded drafts are immutable');
      result = resultFor(draft.id, command.type === 'discardDraft' ? 'discarded' : 'draft');
      cancelPending(state, result, 'draft-changed', intent => intent.draftId === draft.id);
      if (command.type === 'discardDraft') { draft.status = 'discarded'; draft.version += 1; draft.updatedAt = now; break; }
      invariant(ctx.actor.kind === 'human' || command.content.kind === 'research', 'autonomous_content_denied', 'Agents draft structured research inquiries only');
      const rendered = renderContent(state.mailbox.brand, command.content);
      Object.assign(draft, rendered, { content: structuredClone(command.content), version: draft.version + 1,
        authorId: ctx.actor.id, authorKind: ctx.actor.kind, epochs: { ...state.mailbox.epochs },
        threadContextEpoch: find(state.threads, draft.threadId, 'Thread').contextEpoch, status: 'draft', updatedAt: now });
      break;
    }
    case 'setControl': {
      invariant(['human', 'autonomous'].includes(command.mode), 'invalid_control', 'Unknown control mode');
      state.mailbox.control = command.mode;
      bump(state, 'control', result, 'control-changed'); result.status = command.mode; break;
    }
    case 'setResearchContext': {
      state.mailbox.contextLabel = safeHeader(command.contextLabel, 'Research context');
      bump(state, 'context', result, 'context-changed'); break;
    }
    case 'connectMailbox': {
      const connection = command.connection;
      state.mailbox.connection = { provider: provider(connection.provider), accountRef: identifier(connection.accountRef, 'Account reference'),
        connectionRef: identifier(connection.connectionRef, 'Credential handle'), address: normalizeAddress(connection.address) };
      bump(state, 'auth', result, 'mailbox-reconnected'); result.status = 'connected'; break;
    }
    case 'disconnectMailbox': {
      state.mailbox.connection = null; bump(state, 'auth', result, 'mailbox-disconnected'); result.status = 'disconnected'; break;
    }
    case 'issueGrant': {
      state.grants.push(validateGrant(state, ctx, command.grant)); result = resultFor(command.grant.id, 'active'); break;
    }
    case 'revokeGrant': {
      const grant = find(state.grants, command.grantId, 'Send grant'); grant.status = 'revoked';
      result = resultFor(grant.id, 'revoked'); cancelPending(state, result, 'grant-revoked', intent => intent.grantId === grant.id); break;
    }
    case 'suppressRecipient': {
      invariant(['manual', 'opt-out'].includes(command.reason), 'invalid_suppression', 'Invalid suppression reason');
      const address = normalizeAddress(command.address); result.status = 'suppressed'; suppress(state, ctx, address, command.reason, result); break;
    }
    case 'liftSuppression': {
      const address = normalizeAddress(command.address); nonempty(command.consentNote, 'Consent note', 500);
      const active = state.suppressions.filter(item => item.address === address && item.active);
      invariant(active.length > 0, 'not_suppressed', 'Recipient has no active suppression');
      for (const item of active) { item.active = false; item.liftedAt = now; item.consentNote = command.consentNote; }
      bump(state, 'suppression', result, 'suppression-lifted'); result.status = 'unsuppressed'; break;
    }
    case 'queueDraft': {
      unique(state.intents, command.intentId);
      const draft = find(state.drafts, command.draftId, 'Draft');
      invariant(draft.version === command.expectedVersion, 'stale_version', 'Draft revision does not match');
      invariant(draft.status === 'draft', 'draft_locked', 'Draft is not available for approval');
      const thread = requireFreshDraft(state, draft); const grant = find(state.grants, command.grantId, 'Send grant');
      invariant(ctx.actor.kind === (grant.mode === 'human' ? 'human' : 'agent'), 'actor_denied', 'Send approval must match the grant mode');
      const intent: OutboundIntent = { id: command.intentId, threadId: thread.id, draftId: draft.id,
        draftVersion: draft.version, draftDigest: draftDigest(draft), grantId: grant.id, mode: grant.mode,
        actorId: ctx.actor.id, purpose: ctx.purpose, recipient: thread.recipient, fence: fenceFor(state, draft, grant.id),
        createdAt: now, status: 'queued', ticket: null, handoff: null, outcome: null, cancellationReason: null,
        uncertainty: null, reconcileRequests: 0, lastReconcileAt: null };
      maySend(state, ctx, intent); state.intents.push(intent); draft.status = 'queued';
      result = resultFor(intent.id, 'queued'); break;
    }
    case 'cancelIntent': {
      const intent = find(state.intents, command.intentId, 'Outbound intent');
      invariant(ctx.actor.kind === 'human' || intent.actorId === ctx.actor.id, 'intent_owner_denied', 'Cannot cancel another actor’s intent');
      result = resultFor(intent.id, pending(intent) ? 'cancelled' : intent.status);
      cancelPending(state, result, 'explicit-cancellation', other => other.id === intent.id); break;
    }
    case 'prepareDispatch': {
      const intent = find(state.intents, command.intentId, 'Outbound intent');
      invariant(pending(intent), 'intent_not_pending', 'Only queued intents can be prepared');
      invariant(intent.ticket === null || validTime(intent.ticket.expiresAt) <= validTime(now), 'dispatch_claimed', 'Dispatch ticket is already held');
      const { grant } = maySend(state, ctx, intent);
      const id = digest({ ...scopeOf(state), mailboxId: state.mailbox.id, intentId: intent.id, inputId: command.inputId, fence: intent.fence });
      intent.ticket = { id, expiresAt: new Date(Math.min(validTime(now) + 60_000, validTime(grant.expiresAt))).toISOString(), fence: { ...intent.fence } };
      intent.status = 'prepared'; result = resultFor(intent.id, 'prepared'); result.ticketId = id; break;
    }
    case 'handoff': {
      const intent = find(state.intents, command.intentId, 'Outbound intent');
      invariant(intent.status === 'prepared' && intent.ticket && intent.ticket.id === command.ticketId,
        'dispatch_fenced', 'Dispatch ticket is not current');
      invariant(validTime(now) < validTime(intent.ticket.expiresAt), 'ticket_expired', 'Dispatch ticket expired');
      const { draft, grant, thread, connection } = maySend(state, ctx, intent);
      const id = digest({ ...scopeOf(state), mailboxId: state.mailbox.id, intentId: intent.id, ticketId: command.ticketId });
      const domain = connection.address.split('@')[1]!;
      const prior = state.messages.filter(message => message.threadId === thread.id && message.headers.messageId !== null).at(-1);
      const send: GatewaySendCommand = { ...scopeOf(state), kind: 'send', id, mailboxId: state.mailbox.id, intentId: intent.id,
        provider: connection.provider, accountRef: connection.accountRef, connectionRef: connection.connectionRef,
        authEpoch: state.mailbox.epochs.auth, commitRevision: state.revision, at: now, fence: { ...intent.fence },
        envelope: { from: connection.address, to: intent.recipient, subject: draft.subject, body: draft.body,
          headers: { messageId: `<${id}@${domain}>`, inReplyTo: prior?.headers.messageId ?? null,
            references: prior ? [...prior.headers.references, prior.headers.messageId!].slice(-20) : [] } },
        retryPolicy: 'never-blind-retry' };
      intent.handoff = { id, at: now, commandDigest: digest(send), command: structuredClone(send) };
      intent.status = 'handed-off'; intent.ticket = null; draft.status = 'handed-off'; grant.usedSends += 1;
      result = resultFor(intent.id, 'handed-off'); gatewayCommands.push(send); break;
    }
    case 'markUncertain': {
      const intent = find(state.intents, command.intentId, 'Outbound intent');
      invariant(intent.handoff?.id === command.handoffId && unresolved(intent), 'handoff_mismatch', 'Outcome does not match a pending handoff');
      invariant(['timeout', 'crash', 'transport'].includes(command.reason), 'invalid_uncertainty', 'Unknown uncertainty reason');
      intent.status = 'uncertain'; intent.uncertainty = command.reason; intent.outcome = { kind: 'unknown' };
      result = resultFor(intent.id, 'uncertain'); break;
    }
    case 'recordOutcome': {
      const intent = find(state.intents, command.intentId, 'Outbound intent');
      invariant(intent.handoff?.id === command.handoffId, 'handoff_mismatch', 'Outcome does not match the durable handoff');
      validateOutcome(command.outcome);
      if (intent.status === 'accepted' || intent.status === 'rejected') {
        invariant(digest(intent.outcome) === digest(command.outcome), 'outcome_conflict', 'Terminal provider outcome cannot be replaced');
        result = resultFor(intent.id, intent.status); break;
      }
      invariant(unresolved(intent), 'intent_not_handed_off', 'Intent has not been handed off');
      intent.outcome = structuredClone(command.outcome);
      const draft = find(state.drafts, intent.draftId, 'Draft');
      result = resultFor(intent.id, command.outcome.kind);
      if (command.outcome.kind === 'unknown') { intent.status = 'uncertain'; intent.uncertainty = 'transport'; result.status = 'uncertain'; break; }
      intent.uncertainty = null;
      if (command.outcome.kind === 'rejected') {
        intent.status = 'rejected'; draft.status = 'draft';
        if (command.outcome.code === 'auth-denied') {
          // A late response from an old connection must not disconnect a newer account/session.
          if (intent.handoff.command.authEpoch === state.mailbox.epochs.auth) {
            state.mailbox.connection = null; bump(state, 'auth', result, 'provider-auth-denied');
          }
        } else if (command.outcome.code === 'invalid-recipient') suppress(state, ctx, intent.recipient, 'invalid-recipient', result);
        break;
      }
      intent.status = 'accepted'; draft.status = 'accepted';
      const envelope = intent.handoff.command.envelope;
      const thread = find(state.threads, intent.threadId, 'Thread'); thread.lastActivityAt = now;
      state.messages.push({ ...scopeOf(state), id: `out-${intent.handoff.id}`, kind: 'correspondence-message', revision: 1,
        threadId: intent.threadId, direction: 'outbound', ...structuredClone(envelope), at: now, evidence: null,
        providerMessageId: command.outcome.providerMessageId, delivery: 'provider-accepted', intentId: intent.id });
      break;
    }
    case 'requestReconciliation': {
      const intent = find(state.intents, command.intentId, 'Outbound intent');
      invariant(intent.status === 'uncertain' && intent.handoff, 'intent_not_uncertain', 'Only uncertain handoffs can be reconciled');
      const connection = state.mailbox.connection;
      invariant(connection && connection.provider === intent.handoff.command.provider && connection.accountRef === intent.handoff.command.accountRef,
        'reconciliation_account_mismatch', 'Reconnect the original account before reconciliation');
      invariant(intent.lastReconcileAt === null || validTime(now) - validTime(intent.lastReconcileAt) >= 30_000,
        'reconciliation_cooldown', 'Reconciliation is rate limited');
      intent.reconcileRequests += 1; intent.lastReconcileAt = now;
      gatewayCommands.push({ ...scopeOf(state), kind: 'reconcile', id: digest({ handoffId: intent.handoff.id, inputId: command.inputId }),
        mailboxId: state.mailbox.id, intentId: intent.id, handoffId: intent.handoff.id, provider: connection.provider,
        accountRef: connection.accountRef, connectionRef: connection.connectionRef, authEpoch: state.mailbox.epochs.auth,
        messageId: intent.handoff.command.envelope.headers.messageId!, since: intent.handoff.at, retryPolicy: 'read-only' });
      result = resultFor(intent.id, 'reconciling'); break;
    }
    case 'ingestReply': {
      const connection = state.mailbox.connection;
      invariant(connection && command.authEpoch === state.mailbox.epochs.auth && command.accountRef === connection.accountRef
        && command.provider === connection.provider, 'ingress_fenced', 'Reply ingress uses a stale or foreign connection');
      const thread = find(state.threads, command.threadId, 'Thread');
      const from = normalizeAddress(command.from); const to = normalizeAddress(command.to);
      invariant(to === connection.address, 'recipient_mismatch', 'Reply does not target this mailbox');
      const subject = safeHeader(command.subject, 'Subject'); const body = safeBody(command.body);
      const headers = validateMessageHeaders(command.headers); const providerMessageId = providerIdentifier(command.providerMessageId);
      const providerKey = digest({ provider: command.provider, accountRef: command.accountRef, providerMessageId });
      const ingressFingerprint = digest({ threadId: thread.id, from, to, subject, body, headers });
      const existing = state.messages.find(message => message.evidence?.providerKey === providerKey);
      if (existing) {
        invariant(existing.evidence?.ingressFingerprint === ingressFingerprint, 'provider_message_conflict', 'Provider ID was replayed with different evidence');
        result = resultFor(existing.id, 'received-unverified'); result.duplicateEvidence = true; break;
      }
      const id = `in-${providerKey}`;
      state.messages.push({ ...scopeOf(state), id, kind: 'correspondence-message', revision: 1, threadId: thread.id,
        direction: 'inbound', from, to, subject, body, at: now, headers, providerMessageId,
        evidence: { verification: 'unverified', policyAuthority: false, attributedSender: from, source: 'provider-ingress',
          provider: command.provider, accountRef: command.accountRef, providerMessageId, ingressFingerprint, providerKey },
        delivery: 'received-unverified', intentId: null });
      thread.contextEpoch += 1; thread.autonomyPaused = true; thread.read = false; thread.lastActivityAt = now;
      if (thread.folder === 'archive') thread.folder = 'inbox';
      result = resultFor(id, 'received-unverified');
      cancelPending(state, result, 'reply-received', intent => intent.threadId === thread.id);
      // Untrusted text can only restrict contact; it cannot grant authority, change control, or execute commands.
      if (detectsOptOut(body)) suppress(state, ctx, from, 'opt-out', result);
      break;
    }
    case 'setThreadFlags': {
      const thread = find(state.threads, command.threadId, 'Thread'); result = resultFor(thread.id, 'updated');
      if (command.folder !== undefined) {
        invariant(['inbox', 'archive', 'trash', 'spam'].includes(command.folder), 'invalid_folder', 'Unknown folder');
        thread.folder = command.folder;
        if (command.folder === 'trash' || command.folder === 'spam') {
          thread.contextEpoch += 1; thread.autonomyPaused = true;
          cancelPending(state, result, 'thread-inactive', intent => intent.threadId === thread.id);
        }
      }
      if (command.read !== undefined) { invariant(typeof command.read === 'boolean', 'invalid_flag', 'Read flag must be boolean'); thread.read = command.read; }
      if (command.starred !== undefined) { invariant(typeof command.starred === 'boolean', 'invalid_flag', 'Starred flag must be boolean'); thread.starred = command.starred; }
      break;
    }
    case 'resumeThread': {
      const thread = find(state.threads, command.threadId, 'Thread');
      thread.autonomyPaused = false; thread.contextEpoch += 1;
      result = resultFor(thread.id, 'resumed'); cancelPending(state, result, 'thread-context-changed', intent => intent.threadId === thread.id); break;
    }
  }
  state.receipts.push({ inputId: command.inputId, fingerprint, result: structuredClone(result) });
  state.events.push({ sequence: state.events.length + 1, inputId: command.inputId, requestId: ctx.requestId,
    actorId: ctx.actor.id, at: now, type: command.type, entityId: result.entityId, status: result.status });
  return { state, result, gatewayCommands, duplicate: result.duplicateEvidence };
}

function validateOutcome(outcome: ProviderOutcome): void {
  invariant(['accepted', 'rejected', 'unknown'].includes(outcome.kind), 'invalid_outcome', 'Unknown provider outcome');
  if (outcome.kind === 'accepted' && outcome.providerMessageId !== null) providerIdentifier(outcome.providerMessageId);
  if (outcome.kind === 'rejected') invariant(['invalid-recipient', 'auth-denied', 'policy-denied', 'not-accepted'].includes(outcome.code),
    'invalid_outcome', 'Unknown rejection code');
}

/** Verifies a committed handoff, not permission to replay it. The parent must enforce one-shot consumption. */
export function assertCommittedHandoff(state: CorrespondenceState, command: GatewaySendCommand): void {
  requireScope(command, state);
  const intent = find(state.intents, command.intentId, 'Outbound intent');
  invariant(state.mailbox.id === command.mailboxId && state.revision >= command.commitRevision
    && intent.status === 'handed-off' && intent.handoff?.id === command.id && intent.handoff.commandDigest === digest(command),
  'handoff_not_committed', 'Gateway command does not match a committed, unresolved handoff');
}
