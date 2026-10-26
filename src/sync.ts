import { digest, DomainError, invariant, requireScope } from './contracts.ts';
import type { Context } from './contracts.ts';
import type { CorrespondenceState } from './types.ts';
import { transitionCorrespondence } from './machine.ts';
import { normalizeAddress, identifier } from './validation.ts';
import { changedEvidence, invalidMessage, providerKey, text } from './sync-content.ts';
import { syncLimits } from './sync-http.ts';
import { readSyncPage } from './sync-providers.ts';
import type { MailboxSyncSnapshot, MailboxSyncState, MailboxSyncStore, ReadOnlyMailboxTransport, SyncBinding,
  SyncInvocation, MailboxSyncResult, SyncPage, MailboxSyncLimits, QuarantinedContent } from './sync-types.ts';
export type * from './sync-types.ts';
export { DEFAULT_SYNC_LIMITS, readBoundedJson } from './sync-http.ts';

function validateBinding(binding: SyncBinding): void {
  const keys = ['tenantId', 'projectId', 'mailboxId', 'provider', 'accountRef', 'authEpoch', 'address', 'providerAccountId', 'folderId'];
  invariant(Object.keys(binding).length === keys.length && Object.keys(binding).every(key => keys.includes(key)), 'sync_invalid_binding', 'Only public routing fields belong in a sync binding');
  identifier(binding.tenantId); identifier(binding.projectId); identifier(binding.mailboxId); identifier(binding.accountRef);
  invariant(Number.isSafeInteger(binding.authEpoch) && binding.authEpoch >= 0, 'sync_invalid_binding', 'Invalid auth epoch');
  invariant(['gmail', 'graph'].includes(binding.provider), 'sync_invalid_binding', 'Unsupported sync provider');
  invariant(normalizeAddress(binding.address) === binding.address, 'sync_invalid_binding', 'Mailbox address must be normalized');
  text(binding.providerAccountId, 254);
  invariant(!['.', '..', 'me'].includes(binding.providerAccountId) && !/[/?#\\]/.test(binding.providerAccountId), 'sync_invalid_binding', 'An explicit provider account is required');
  if (binding.provider === 'gmail') invariant(normalizeAddress(binding.providerAccountId) === binding.address && binding.folderId === null,
    'sync_invalid_binding', 'Gmail sync is bound to its explicit mailbox address');
  else { text(binding.folderId, 512); invariant(!['.', '..'].includes(binding.folderId!) && !/[?#\\]/.test(binding.folderId!), 'sync_invalid_binding', 'Invalid Graph folder'); }
}
export function assertSyncBinding(state: CorrespondenceState, binding: SyncBinding, transport: ReadOnlyMailboxTransport): void {
  validateBinding(binding); requireScope(binding, state);
  const connection = state.mailbox.connection;
  invariant(state.mailbox.id === binding.mailboxId && connection?.provider === binding.provider
    && connection.accountRef === binding.accountRef && state.mailbox.epochs.auth === binding.authEpoch
    && connection.address === binding.address, 'sync_fenced', 'Mailbox synchronization identity is stale');
  invariant(digest(transport.binding) === digest(binding), 'sync_transport_mismatch', 'Transport belongs to another mailbox identity');
}
export function createMailboxSyncState(binding: SyncBinding): MailboxSyncState {
  validateBinding(binding);
  return { binding: structuredClone(binding), revision: 0, cursor: null, records: [], quarantine: [] };
}
function assertSnapshot(snapshot: MailboxSyncSnapshot, binding: SyncBinding, transport: ReadOnlyMailboxTransport): void {
  assertSyncBinding(snapshot.correspondence, binding, transport);
  invariant(digest(snapshot.sync.binding) === digest(binding), 'sync_checkpoint_mismatch', 'Checkpoint belongs to another scope, account, collection or auth epoch');
  invariant(Number.isSafeInteger(snapshot.sync.revision) && snapshot.sync.revision >= 0, 'sync_invalid_checkpoint', 'Invalid sync revision');
}
function authorize(ctx: Context, state: CorrespondenceState): void {
  requireScope(ctx, state);
  invariant(ctx.actor.kind === 'service' && ctx.actor.roles.includes('correspondence:ingress'), 'permission_denied', 'Mailbox sync requires authenticated ingress service authority');
}
async function load(store: MailboxSyncStore, binding: SyncBinding): Promise<MailboxSyncSnapshot> {
  try { return structuredClone(await store.load(binding)); }
  catch { throw new DomainError('sync_store_failed', 'Mailbox sync snapshot could not be loaded'); }
}
function applyPage(snapshot: MailboxSyncSnapshot, page: SyncPage, ctx: Context, limits: MailboxSyncLimits): { next: MailboxSyncSnapshot; ingested: number; quarantined: number } {
  const sync = structuredClone(snapshot.sync); let correspondence = snapshot.correspondence; const binding = sync.binding;
  let ingested = 0; let quarantined = 0;
  function isolate(items: QuarantinedContent[]) {
    for (const item of items) {
      if (!sync.quarantine.some(existing => existing.key === item.key)) { sync.quarantine.push(item); quarantined++; }
    }
    invariant(sync.quarantine.length <= limits.maxRecords * 10, 'sync_cache_limit', 'Quarantine store reached its bounded capacity');
  }
  for (const change of page.changes) {
    const key = providerKey(binding, change.id);
    let record = sync.records.find(item => item.key === key);
    if (!record) {
      invariant(sync.records.length < limits.maxRecords, 'sync_cache_limit', 'Mailbox cache reached its bounded capacity');
      record = { key, providerMessageId: change.id, message: null, deleted: false, seenGeneration: null, ingestedMessageId: null };
      sync.records.push(record);
    }
    if (page.generation !== null) record.seenGeneration = page.generation;
    if (change.invalid) { isolate([invalidMessage(change.id)]); continue; }
    if (!change.message) { record.deleted = true; continue; }
    const message = change.message; record.deleted = false; isolate(message.quarantine);
    // Cache provider metadata, including sent/draft records, without fabricating a send acceptance.
    record.message = structuredClone(message);
    if (message.draft || message.sent || message.from === binding.address || !message.to.includes(binding.address)) continue;
    const existing = correspondence.messages.find(item => item.evidence?.providerKey === key);
    const matchedOutbound = correspondence.messages.find(item => item.direction === 'outbound'
      && item.to === message.from && item.headers.messageId !== null
      && [message.headers.inReplyTo, ...message.headers.references].includes(item.headers.messageId));
    const threadId = existing?.threadId ?? matchedOutbound?.threadId ?? `sync-${digest({ provider: binding.provider,
      accountRef: binding.accountRef, providerThreadId: message.providerThreadId, sender: message.from })}`;
    const fingerprint = digest({ threadId, from: message.from, to: binding.address, subject: message.subject,
      body: message.text, headers: message.headers });
    if (existing) {
      record.ingestedMessageId = existing.id;
      if (existing.evidence?.ingressFingerprint !== fingerprint) isolate([changedEvidence(change.id)]);
      continue;
    }
    const command = { type: 'ingestReply' as const, inputId: `sync-${digest({ key, fingerprint, actor: ctx.actor.id, purpose: ctx.purpose })}`,
      threadId, createThread: true, provider: binding.provider, accountRef: binding.accountRef, authEpoch: binding.authEpoch,
      providerMessageId: message.providerMessageId, from: message.from, to: binding.address, subject: message.subject,
      body: message.text, headers: message.headers };
    const transition = transitionCorrespondence(correspondence, ctx, command);
    invariant(transition.gatewayCommands.length === 0, 'sync_read_only', 'Reply ingestion must not emit outbound effects');
    correspondence = transition.state; record.ingestedMessageId = transition.result.entityId; ingested++;
  }
  if (page.completeGeneration) for (const record of sync.records) if (record.seenGeneration !== page.generation) record.deleted = true;
  sync.cursor = structuredClone(page.cursor); sync.revision++;
  return { next: { sync, correspondence }, ingested, quarantined };
}

/** Each page is ingested and checkpointed in one host-provided durable compare-and-swap transaction. */
export async function synchronizeMailbox(input: SyncInvocation): Promise<MailboxSyncResult> {
  const { context, store } = input; const binding = structuredClone(input.binding); const limits = syncLimits(input.limits);
  const transport = input.transport;
  const result: MailboxSyncResult = { pagesCommitted: 0, ingested: 0, quarantined: 0, resyncs: 0, more: false };
  for (let pageNumber = 0; pageNumber < limits.maxPages; pageNumber++) {
    const snapshot = await load(store, binding); assertSnapshot(snapshot, binding, transport); authorize(context, snapshot.correspondence);
    const page = await readSyncPage(binding, snapshot.sync, transport, limits);
    // Re-read after I/O: reconnect/takeover or another worker may have changed authority/state meanwhile.
    const current = await load(store, binding); assertSnapshot(current, binding, transport); authorize(context, current.correspondence);
    invariant(current.sync.revision === snapshot.sync.revision, 'sync_commit_conflict', 'Another sync worker advanced this checkpoint');
    const applied = applyPage(current, page, context, limits);
    let committed: boolean;
    try { committed = await store.commit({ binding, expectedSyncRevision: current.sync.revision,
      expectedCorrespondenceRevision: current.correspondence.revision, next: applied.next }); }
    catch { throw new DomainError('sync_commit_failed', 'Mailbox page transaction did not confirm persistence'); }
    invariant(committed, 'sync_commit_conflict', 'Mailbox page transaction lost its revision comparison');
    result.pagesCommitted++; result.ingested += applied.ingested; result.quarantined += applied.quarantined;
    if (page.reset) result.resyncs++;
    result.more = page.more;
    if (!page.more) break;
  }
  return result;
}
