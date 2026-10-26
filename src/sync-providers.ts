import { digest, invariant } from './contracts.ts';
import type { MailboxSyncState, ReadOnlyMailboxTransport, MailboxSyncLimits, SyncPage, SyncBinding, SyncCursor } from './sync-types.ts';
import { historyId, list, normalizeGmailMessage, normalizeGraphMessage, object, providerMessageId, text } from './sync-content.ts';
import { getJson, gmailRoot, graphRoot, graphCursorUrl, successful } from './sync-http.ts';
import { normalizeAddress } from './validation.ts';

function token(value: unknown): string | null { return value === undefined ? null : text(value, 4096); }
async function gmailFull(binding: SyncBinding, state: MailboxSyncState, transport: ReadOnlyMailboxTransport,
  limits: MailboxSyncLimits, reset: boolean): Promise<SyncPage> {
  const cursor = !reset && state.cursor?.kind === 'gmail-full' ? state.cursor : null;
  let baseline = cursor?.baselineHistoryId;
  if (!baseline) {
    const profile = successful(await getJson(transport, `${gmailRoot(binding)}/profile`, limits));
    invariant(normalizeAddress(text(profile.emailAddress, 254)) === binding.address, 'sync_account_mismatch', 'Gmail profile belongs to another mailbox');
    baseline = historyId(profile.historyId);
  }
  const generation = cursor?.generation ?? digest({ binding, revision: state.revision, baseline });
  const query = new URLSearchParams({ maxResults: String(limits.pageSize), includeSpamTrash: 'true' });
  if (cursor) query.set('pageToken', cursor.pageToken);
  const page = successful(await getJson(transport, `${gmailRoot(binding)}/messages?${query}`, limits));
  const ids = list(page.messages, limits.pageSize, true).map(raw => providerMessageId(object(raw).id));
  const next = token(page.nextPageToken);
  invariant(!cursor || next !== cursor.pageToken, 'sync_cursor_loop', 'Gmail pagination did not advance');
  return { changes: await fetchMessages(binding, ids, transport, limits),
    cursor: next ? { kind: 'gmail-full', pageToken: next, baselineHistoryId: baseline, generation }
      : { kind: 'gmail-history', historyId: baseline, pageToken: null },
    generation, completeGeneration: !next, more: true, reset };
}
async function fetchMessages(binding: SyncBinding, ids: string[], transport: ReadOnlyMailboxTransport, limits: MailboxSyncLimits): Promise<SyncPage['changes']> {
  const unique = [...new Set(ids)];
  invariant(unique.length <= limits.maxChanges, 'sync_page_limit', 'Provider page has too many changed messages');
  const changes: SyncPage['changes'] = [];
  for (const id of unique) {
    const url = binding.provider === 'gmail' ? `${gmailRoot(binding)}/messages/${encodeURIComponent(id)}?format=full`
      : `${graphRoot(binding)}/mailFolders/${encodeURIComponent(binding.folderId!)}/messages/${encodeURIComponent(id)}?${new URLSearchParams({ '$select': 'id,conversationId,from,toRecipients,subject,body,internetMessageId,internetMessageHeaders,isRead,isDraft,hasAttachments' })}`;
    const response = await getJson(transport, url, limits, true);
    if (response.status === 404) { changes.push({ id, message: null, invalid: false }); continue; }
    const raw = successful(response);
    invariant(raw.id === id, 'sync_message_mismatch', 'Provider returned a different message');
    try {
      const message = binding.provider === 'gmail' ? normalizeGmailMessage(raw, limits) : normalizeGraphMessage(raw, limits);
      changes.push({ id, message, invalid: false });
    } catch { changes.push({ id, message: null, invalid: true }); }
    invariant(Buffer.byteLength(JSON.stringify(changes)) <= limits.maxBatchBytes, 'sync_batch_limit', 'Normalized page exceeds its byte bound');
  }
  return changes;
}
export async function readSyncPage(binding: SyncBinding, state: MailboxSyncState, transport: ReadOnlyMailboxTransport, limits: MailboxSyncLimits): Promise<SyncPage> {
  if (binding.provider === 'gmail') {
    invariant(state.cursor === null || state.cursor.kind !== 'graph-delta', 'sync_cursor_mismatch', 'Cursor belongs to another provider');
    if (!state.cursor || state.cursor.kind === 'gmail-full') return gmailFull(binding, state, transport, limits, false);
    invariant(state.cursor.kind === 'gmail-history', 'sync_cursor_mismatch', 'Expected Gmail history cursor');
    const query = new URLSearchParams({ startHistoryId: historyId(state.cursor.historyId), maxResults: String(limits.pageSize) });
    if (state.cursor.pageToken) query.set('pageToken', text(state.cursor.pageToken, 4096));
    const response = await getJson(transport, `${gmailRoot(binding)}/history?${query}`, limits);
    if (response.status === 404) return gmailFull(binding, state, transport, limits, true);
    const page = successful(response); const ids: string[] = [];
    for (const history of list(page.history, limits.pageSize, true).map(object)) {
      for (const raw of list(history.messages, limits.maxChanges, true)) ids.push(providerMessageId(object(raw).id));
      for (const field of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
        for (const raw of list(history[field], limits.maxChanges, true)) ids.push(providerMessageId(object(object(raw).message).id));
      }
      invariant(ids.length <= limits.maxChanges * 5, 'sync_page_limit', 'Provider page expands beyond its bound');
    }
    const next = token(page.nextPageToken);
    invariant(!state.cursor.pageToken || next !== state.cursor.pageToken, 'sync_cursor_loop', 'Gmail pagination did not advance');
    const end = historyId(page.historyId);
    invariant(BigInt(end) >= BigInt(state.cursor.historyId), 'sync_cursor_reversed', 'Gmail history moved backwards');
    return { changes: await fetchMessages(binding, ids, transport, limits), cursor: { kind: 'gmail-history',
      historyId: next ? state.cursor.historyId : end, pageToken: next }, generation: null, completeGeneration: false, more: next !== null, reset: false };
  }
  invariant(state.cursor === null || state.cursor.kind === 'graph-delta', 'sync_cursor_mismatch', 'Cursor belongs to another provider');
  const graphCursor = state.cursor?.kind === 'graph-delta' ? state.cursor : null;
  invariant(graphCursor === null || graphCursor.kind === 'graph-delta', 'sync_cursor_mismatch', 'Expected Graph delta cursor');
  const initial = `${graphRoot(binding)}/mailFolders/${encodeURIComponent(binding.folderId!)}/messages/delta?${new URLSearchParams({ '$select': 'id,changeKey,isRead', '$top': String(limits.pageSize) })}`;
  let url = graphCursor ? graphCursorUrl(binding, graphCursor.url) : initial;
  let generation = graphCursor?.generation ?? (graphCursor ? null : digest({ binding, revision: state.revision }));
  let response = await getJson(transport, url, limits); let reset = false;
  if ((response.status === 410 || response.errorCode === 'syncStateNotFound') && state.cursor) {
    reset = true; generation = digest({ binding, revision: state.revision, resync: true });
    url = initial; response = await getJson(transport, url, limits);
  }
  const page = successful(response); const entries = list(page.value, limits.pageSize).map(object);
  const next = page['@odata.nextLink']; const delta = page['@odata.deltaLink'];
  invariant((next === undefined) !== (delta === undefined), 'sync_invalid_response', 'Graph must return exactly one state link');
  const nextUrl = graphCursorUrl(binding, next ?? delta);
  invariant(!next || nextUrl !== url, 'sync_cursor_loop', 'Graph pagination did not advance');
  const linkParams = new URL(nextUrl).searchParams;
  invariant(next ? linkParams.has('$skiptoken') : linkParams.has('$deltatoken'), 'sync_invalid_response', 'Graph state link has the wrong token type');
  // Resolve current folder membership, even for tombstones: replay ordering cannot resurrect or delete the wrong item.
  const changes = await fetchMessages(binding, entries.map(entry => providerMessageId(entry.id)), transport, limits);
  const cursor: SyncCursor = { kind: 'graph-delta', url: nextUrl, phase: next ? 'next' : 'delta', generation: next ? generation : null };
  return { changes, cursor, generation, completeGeneration: !next && generation !== null, more: next !== undefined, reset };
}
