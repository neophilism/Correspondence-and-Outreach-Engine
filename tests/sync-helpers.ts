import assert from 'node:assert/strict';
import { harness } from './helpers.ts';
import { createMailboxSyncState, synchronizeMailbox } from '../src/index.ts';
import type { SyncBinding, MailboxSyncSnapshot, ReadOnlyMailboxTransport, ReadRequest, MailboxSyncStore, ReadResponse, MailboxSyncLimits } from '../src/index.ts';

export const gmailBase = 'https://gmail.googleapis.com/gmail/v1/users/research%40alpha.example';
export const graphBase = 'https://graph.microsoft.com/v1.0/users/provider-account-a/mailFolders/inbox';
export const graphLink = (token: string, phase = 'delta') => `${graphBase}/messages/delta?$${phase === 'next' ? 'skiptoken' : 'deltatoken'}=${token}`;
export function gmailMessage(id = 'message-1', body = 'Please share more details.', extra: Record<string, unknown> = {}) {
  return { id, threadId: 'conversation-1', labelIds: ['INBOX', 'UNREAD'], historyId: '101',
    payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'Records Team <records@beta.example>' }, { name: 'To', value: 'research@alpha.example' },
      { name: 'Subject', value: 'Re: Records' }, { name: 'Message-ID', value: `<${id}@beta.example>` },
    ], body: { size: Buffer.byteLength(body), data: Buffer.from(body).toString('base64url') } }, ...extra };
}
export function graphMessage(id = 'message-1', body = 'Please share more details.', extra: Record<string, unknown> = {}) {
  return { id, conversationId: 'conversation-1', from: { emailAddress: { address: 'records@beta.example' } },
    toRecipients: [{ emailAddress: { address: 'research@alpha.example' } }], subject: 'Re: Records',
    body: { contentType: 'text', content: body }, internetMessageId: `<${id}@beta.example>`, internetMessageHeaders: [],
    isRead: false, isDraft: false, hasAttachments: false, ...extra };
}
export function response(value: unknown, status = 200): ReadResponse {
  return { status, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() };
}
export function syncHarness(provider: 'gmail' | 'graph' = 'gmail') {
  const domain = harness('connectMailbox');
  domain.step({ type: 'connectMailbox', connection: { provider, accountRef: 'alpha-account', connectionRef: 'external-handle', address: 'research@alpha.example' } });
  const binding: SyncBinding = { tenantId: domain.state.tenantId, projectId: domain.state.projectId,
    mailboxId: domain.state.mailbox.id, provider, accountRef: 'alpha-account', authEpoch: domain.state.mailbox.epochs.auth,
    address: 'research@alpha.example', providerAccountId: provider === 'gmail' ? 'research@alpha.example' : 'provider-account-a',
    folderId: provider === 'gmail' ? null : 'inbox' };
  const ctx = { ...domain.gateway, actor: { ...domain.gateway.actor, roles: ['correspondence:ingress'] } };
  let snapshot: MailboxSyncSnapshot = { sync: createMailboxSyncState(binding), correspondence: domain.state };
  const requests: ReadRequest[] = []; const replies: ((request: ReadRequest) => ReadResponse | Promise<ReadResponse>)[] = [];
  const transport: ReadOnlyMailboxTransport = { binding: structuredClone(binding), async read(request) {
    requests.push(request); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal); assert.equal(Object.keys(request.headers).some(k => /authorization/i.test(k)), false);
    const next = replies.shift(); assert.ok(next, `Unexpected read: ${request.url}`); return next(request);
  } };
  let failBefore = false; let failAfter = false; let conflict = false; let commitCount = 0;
  const store: MailboxSyncStore = { async load() { return structuredClone(snapshot); }, async commit(input) {
    if (failBefore) throw new Error('storage unavailable');
    if (conflict || input.expectedSyncRevision !== snapshot.sync.revision || input.expectedCorrespondenceRevision !== snapshot.correspondence.revision) return false;
    assert.equal(input.next.sync.revision, snapshot.sync.revision + 1);
    snapshot = structuredClone(input.next); commitCount++;
    if (failAfter) throw new Error('acknowledgement lost');
    return true;
  } };
  return { binding, ctx, transport, store, requests, replies, domain,
    get snapshot() { return snapshot; }, get commits() { return commitCount; },
    setSnapshot(next: MailboxSyncSnapshot) { snapshot = structuredClone(next); },
    failBefore(value = true) { failBefore = value; }, failAfter(value = true) { failAfter = value; }, conflict(value = true) { conflict = value; },
    add(value: unknown, status = 200, check?: (request: ReadRequest) => void) { replies.push(request => { check?.(request); return response(value, status); }); },
    run(limits: Partial<MailboxSyncLimits> = {}) { return synchronizeMailbox({ binding, context: ctx, transport, store, limits: { maxPages: 1, ...limits } }); },
    gmailFull(message: unknown = gmailMessage(), nextPageToken?: string) {
      this.add({ emailAddress: binding.address, historyId: '100' }, 200, r => assert.equal(r.url, `${gmailBase}/profile`));
      this.add({ messages: [{ id: (message as { id: string }).id }], ...(nextPageToken ? { nextPageToken } : {}) });
      this.add(message);
    },
    graphPage(message: unknown = graphMessage(), link = graphLink('finished')) {
      this.add({ value: [{ id: (message as { id: string }).id }], '@odata.deltaLink': link }); this.add(message);
    },
  };
}
