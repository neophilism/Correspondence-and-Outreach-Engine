import { scoped } from '@accountability/evidence/database';
import type { Database, UnitOfWork } from '@accountability/evidence/database';
import type { Context, Scope } from './contracts.ts';
import { invariant, requireScope, digest } from './contracts.ts';
import { createCorrespondenceState, transitionCorrespondence, assertCommittedHandoff } from './machine.ts';
import { assertMailboxSyncConnection, createMailboxSyncState } from './sync.ts';
import { identifier } from './validation.ts';
import type { CorrespondenceState, CorrespondenceCommand, CorrespondenceTransition, GatewaySendCommand, ProviderOutcome } from './types.ts';
import type { SyncBinding, MailboxSyncStore, MailboxSyncState } from './sync-types.ts';

/** The Evidence SDK is reused ONLY on a dedicated correspondence database, never an operational upstream DB. */
const MAILBOX_KIND = 'correspondence-mailbox-v1';
const mailboxKey = (mailboxId: string) => { identifier(mailboxId, 'Mailbox'); return digest({ mailboxId }); };
const slotKey = ({ provider, accountRef, providerAccountId, folderId, address }: SyncBinding) =>
  digest({ provider, accountRef, providerAccountId, folderId, address });

type SyncSlot = { generation: number; checkpoint: MailboxSyncState };
type Consumption = { generation: number; commandDigest: string; actorId: string; at: string };
type DurableMailbox = { schemaVersion: 1; state: CorrespondenceState; slots: Record<string, SyncSlot>; consumed: Record<string, Consumption> };
export type HandoffConsumption = Scope & { mailboxId: string; handoffId: string; intentId: string; generation: number; commandDigest: string };
export type ConsumedHandoff = { command: GatewaySendCommand; consumption: HandoffConsumption };

function role(ctx: Context, required: string, kind?: Context['actor']['kind']): void {
  invariant(!kind || ctx.actor.kind === kind, 'actor_denied', 'Actor kind is not permitted');
  invariant(ctx.actor.roles.includes(required) || (ctx.actor.kind === 'human' && ctx.actor.roles.includes('correspondence:admin')),
    'permission_denied', 'Correspondence permission is required');
}
function readable(ctx: Context): void {
  invariant(ctx.actor.roles.includes('correspondence:read') || (ctx.actor.kind === 'human' && ctx.actor.roles.includes('correspondence:admin'))
    || (ctx.actor.kind === 'service' && ctx.actor.roles.some(r => ['correspondence:ingress', 'correspondence:gateway'].includes(r))),
    'permission_denied', 'Mailbox state read permission is required');
}
function revision(value: number): void { invariant(Number.isSafeInteger(value) && value >= 0, 'invalid_revision', 'Expected revision must be nonnegative'); }
function conflict(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'revision_conflict'; }
async function read(tx: UnitOfWork, ctx: Context, mailboxId: string) {
  const row = await tx.get<DurableMailbox>(MAILBOX_KIND, mailboxKey(mailboxId));
  invariant(row, 'not_found', 'Mailbox was not found');
  const value = row.value; requireScope(ctx, value.state);
  invariant(value.schemaVersion === 1 && value.state.schemaVersion === 1 && value.state.mailbox.id === mailboxId,
    'invalid_snapshot', 'Mailbox snapshot identity or schema is invalid');
  return row;
}

/** Validate domain changes as actual ingress transitions, rather than accepting a caller-edited aggregate. */
function replayIngress(current: CorrespondenceState, next: CorrespondenceState, ctx: Context): void {
  requireScope(ctx, next);
  invariant(next.events.length >= current.events.length, 'invalid_sync_transition', 'Sync cannot remove domain events');
  let replayed = current;
  for (const event of next.events.slice(current.events.length)) {
    const message = next.messages.find(item => item.id === event.entityId);
    invariant(event.type === 'ingestReply' && message?.direction === 'inbound' && message.evidence,
      'invalid_sync_transition', 'Sync can only append reply evidence');
    replayed = transitionCorrespondence(replayed, ctx, { type: 'ingestReply', inputId: event.inputId, threadId: message.threadId,
      createThread: true, provider: message.evidence.provider, accountRef: message.evidence.accountRef,
      authEpoch: current.mailbox.epochs.auth, providerMessageId: message.evidence.providerMessageId, from: message.from,
      to: message.to, subject: message.subject, body: message.body, headers: message.headers }).state;
  }
  invariant(digest(replayed) === digest(next), 'invalid_sync_transition', 'Sync candidate is not an authorized ingress transition');
}
function validateSyncAdvance(current: MailboxSyncState, next: MailboxSyncState, binding: SyncBinding): void {
  invariant(digest(next.binding) === digest(binding) && next.revision === current.revision + 1,
    'invalid_sync_transition', 'Sync must advance one bound checkpoint revision');
  const keys = new Set<string>();
  for (const record of next.records) {
    const key = digest({ provider: binding.provider, accountRef: binding.accountRef, providerMessageId: record.providerMessageId });
    invariant(record.key === key && !keys.has(key), 'invalid_sync_transition', 'Sync records must have unique provider-account message keys');
    keys.add(key);
  }
  invariant(current.records.every(record => keys.has(record.key)), 'invalid_sync_transition', 'Sync must retain tombstones for prior records');
}

export class CorrespondenceRepository {
  readonly #database: Database;
  constructor(database: Database) { this.#database = database; }

  async initialize(context: Context, input: Parameters<typeof createCorrespondenceState>[1]): Promise<CorrespondenceState> {
    const ctx = structuredClone(context); const state = createCorrespondenceState(ctx, structuredClone(input));
    return scoped(this.#database, ctx, async tx => {
      await tx.put<DurableMailbox>(MAILBOX_KIND, mailboxKey(state.mailbox.id), 0, { schemaVersion: 1, state, slots: {}, consumed: {} });
      return state;
    });
  }

  async load(context: Context, mailboxId: string): Promise<CorrespondenceState> {
    const ctx = structuredClone(context); readable(ctx);
    return scoped(this.#database, ctx, async tx => (await read(tx, ctx, mailboxId)).value.state);
  }

  /** Handoff commands returned here are descriptions, not execution permission: consumeHandoff is required. */
  async execute(context: Context, mailboxId: string, expectedDomainRevision: number, input: CorrespondenceCommand): Promise<CorrespondenceTransition> {
    const ctx = structuredClone(context); const command = structuredClone(input); revision(expectedDomainRevision);
    return scoped(this.#database, ctx, async tx => {
      const row = await read(tx, ctx, mailboxId);
      const replay = row.value.state.receipts.some(receipt => receipt.inputId === command.inputId);
      invariant(replay || row.value.state.revision === expectedDomainRevision, 'revision_conflict', 'Mailbox domain revision changed');
      const transition = transitionCorrespondence(row.value.state, ctx, command);
      if (transition.state.revision !== row.value.state.revision) await tx.put(MAILBOX_KIND, mailboxKey(mailboxId), row.revision, { ...row.value, state: transition.state });
      return transition;
    });
  }

  async openSyncStore(context: Context, input: SyncBinding): Promise<MailboxSyncStore> {
    const ctx = structuredClone(context); const binding = structuredClone(input); role(ctx, 'correspondence:ingress', 'service');
    const fresh = createMailboxSyncState(binding);
    const key = slotKey(binding);
    const generation = await scoped(this.#database, ctx, async tx => {
      const row = await read(tx, ctx, binding.mailboxId); assertMailboxSyncConnection(row.value.state, binding);
      const prior = row.value.slots[key];
      if (prior && digest(prior.checkpoint.binding) === digest(binding)) return prior.generation;
      const nextGeneration = (prior?.generation ?? 0) + 1;
      invariant(Number.isSafeInteger(nextGeneration), 'generation_exhausted', 'Checkpoint generation exhausted');
      row.value.slots[key] = { generation: nextGeneration, checkpoint: fresh };
      await tx.put(MAILBOX_KIND, mailboxKey(binding.mailboxId), row.revision, row.value);
      return nextGeneration;
    });
    function bound(candidate: SyncBinding): void { invariant(digest(candidate) === digest(binding), 'sync_checkpoint_mismatch', 'Store is bound to a different synchronization identity'); }
    function slot(value: DurableMailbox): SyncSlot {
      assertMailboxSyncConnection(value.state, binding);
      const found = value.slots[key];
      invariant(found?.generation === generation && digest(found.checkpoint.binding) === digest(binding),
        'stale_sync_generation', 'Synchronization generation was superseded');
      return found;
    }
    return {
      load: async candidate => {
        bound(structuredClone(candidate));
        return scoped(this.#database, ctx, async tx => {
          const row = await read(tx, ctx, binding.mailboxId); const current = slot(row.value);
          return { correspondence: row.value.state, sync: current.checkpoint };
        });
      },
      commit: async input => {
        const captured = structuredClone(input); bound(captured.binding);
        revision(captured.expectedSyncRevision); revision(captured.expectedCorrespondenceRevision);
        try {
          return await scoped(this.#database, ctx, async tx => {
            const row = await read(tx, ctx, binding.mailboxId); const current = slot(row.value);
            if (current.checkpoint.revision !== captured.expectedSyncRevision || row.value.state.revision !== captured.expectedCorrespondenceRevision) return false;
            validateSyncAdvance(current.checkpoint, captured.next.sync, binding);
            replayIngress(row.value.state, captured.next.correspondence, ctx);
            row.value.state = captured.next.correspondence;
            row.value.slots[key] = { generation, checkpoint: captured.next.sync };
            await tx.put(MAILBOX_KIND, mailboxKey(binding.mailboxId), row.revision, row.value);
            return true;
          });
        } catch (error) { if (conflict(error)) return false; throw error; }
      },
    };
  }

  /** One-shot consumption is durable BEFORE returning any command. Never reclaim this marker to resend. */
  async consumeHandoff(context: Context, mailboxId: string, input: GatewaySendCommand): Promise<ConsumedHandoff> {
    const ctx = structuredClone(context); const command = structuredClone(input); role(ctx, 'correspondence:gateway', 'service');
    return scoped(this.#database, ctx, async tx => {
      const row = await read(tx, ctx, mailboxId);
      invariant(!row.value.consumed[command.id], 'handoff_consumed', 'Handoff was already consumed and cannot be resent');
      assertCommittedHandoff(row.value.state, command);
      const transition = transitionCorrespondence(row.value.state, ctx, { type: 'markUncertain', inputId: `consume-${command.id}`,
        intentId: command.intentId, handoffId: command.id, reason: 'crash' });
      row.value.state = transition.state;
      row.value.consumed[command.id] = { generation: 1, commandDigest: digest(command), actorId: ctx.actor.id, at: ctx.now };
      await tx.put(MAILBOX_KIND, mailboxKey(mailboxId), row.revision, row.value);
      return { command, consumption: { tenantId: ctx.tenantId, projectId: ctx.projectId, mailboxId, handoffId: command.id,
        intentId: command.intentId, generation: 1, commandDigest: digest(command) } };
    });
  }

  async recordHandoffOutcome(context: Context, input: HandoffConsumption, outcome: ProviderOutcome): Promise<CorrespondenceTransition> {
    const ctx = structuredClone(context); const handle = structuredClone(input); const capturedOutcome = structuredClone(outcome);
    role(ctx, 'correspondence:gateway', 'service'); requireScope(ctx, handle);
    return scoped(this.#database, ctx, async tx => {
      const row = await read(tx, ctx, handle.mailboxId); const marker = row.value.consumed[handle.handoffId];
      invariant(marker && marker.generation === handle.generation && marker.commandDigest === handle.commandDigest && marker.actorId === ctx.actor.id,
        'stale_handoff_generation', 'Handoff consumption handle is stale or belongs to another actor');
      const intent = row.value.state.intents.find(item => item.id === handle.intentId);
      invariant(intent?.handoff?.id === handle.handoffId, 'handoff_mismatch', 'Consumption does not match intent');
      const transition = transitionCorrespondence(row.value.state, ctx, { type: 'recordOutcome', inputId: `outcome-${digest({ handle, outcome: capturedOutcome })}`,
        intentId: handle.intentId, handoffId: handle.handoffId, outcome: capturedOutcome });
      if (transition.state.revision !== row.value.state.revision) await tx.put(MAILBOX_KIND, mailboxKey(handle.mailboxId), row.revision, { ...row.value, state: transition.state });
      return transition;
    });
  }
}
