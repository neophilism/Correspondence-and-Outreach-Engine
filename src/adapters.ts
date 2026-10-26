import { digest, invariant } from './contracts.ts';
import type { Json } from './contracts.ts';
import type { GatewayCommand, GatewayReconcileCommand, GatewaySendCommand, ProviderOutcome } from './types.ts';
import { isoTime, normalizeAddress, providerIdentifier, safeBody, safeHeader, validateMessageHeaders } from './validation.ts';

/** Transport descriptions only. An external gateway owns credential resolution, dispatch, and response authentication. */
export type ProtocolRequest = {
  provider: 'gmail' | 'graph'; commandId: string; method: 'POST' | 'GET'; url: string;
  headers: { 'Content-Type': 'application/json' }; body: Json; credentialHandle: string;
  accountRef: string; expectedAuthEpoch: number; retryPolicy: 'never-blind-retry' | 'read-only';
};

function validateSend(command: GatewaySendCommand): void {
  invariant(command.kind === 'send' && /^[a-f0-9]{64}$/.test(command.id), 'invalid_gateway_command', 'Invalid send command');
  invariant(command.retryPolicy === 'never-blind-retry', 'invalid_gateway_command', 'Send cannot request automatic retry');
  normalizeAddress(command.envelope.from); normalizeAddress(command.envelope.to);
  safeHeader(command.envelope.subject); safeBody(command.envelope.body); validateMessageHeaders(command.envelope.headers);
  invariant(command.envelope.headers.messageId !== null, 'invalid_message_id', 'Outbound message needs a stable message ID');
  isoTime(command.at);
}

function encodedSubject(value: string): string {
  // RFC 2047 encoded words, each below the 75-character limit; split on Unicode code points.
  const chunks: string[] = []; let current = '';
  for (const char of value) {
    if (Buffer.byteLength(current + char, 'utf8') > 42) { chunks.push(current); current = ''; }
    current += char;
  }
  if (current) chunks.push(current);
  return chunks.map(chunk => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ');
}

export function encodeRfc5322(command: GatewaySendCommand): string {
  validateSend(command);
  const { envelope } = command;
  const headers = [
    `From: ${envelope.from}`, `To: ${envelope.to}`, `Subject: ${encodedSubject(envelope.subject)}`,
    `Date: ${new Date(command.at).toUTCString()}`, `Message-ID: ${envelope.headers.messageId}`,
    `X-Accountability-Handoff: ${command.id}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (envelope.headers.inReplyTo) headers.push(`In-Reply-To: ${envelope.headers.inReplyTo}`);
  if (envelope.headers.references.length) headers.push(`References: ${envelope.headers.references.join('\r\n ')}`);
  const body = Buffer.from(safeBody(envelope.body).replace(/\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

function plan(command: GatewayCommand, provider: 'gmail' | 'graph', method: 'POST' | 'GET', url: string, body: Json): ProtocolRequest {
  invariant(command.provider === provider, 'provider_mismatch', 'Command targets another provider');
  return { provider, commandId: command.id, method, url, body, headers: { 'Content-Type': 'application/json' },
    credentialHandle: command.connectionRef, accountRef: command.accountRef, expectedAuthEpoch: command.authEpoch, retryPolicy: command.retryPolicy };
}

export function gmailProtocolRequest(command: GatewayCommand): ProtocolRequest {
  if (command.kind === 'send') {
    return plan(command, 'gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { raw: Buffer.from(encodeRfc5322(command), 'utf8').toString('base64url') });
  }
  validateReconcile(command);
  // Gmail list results must still be fetched and verified; a search hit is not acceptance evidence on its own.
  const query = new URLSearchParams({ q: `in:sent rfc822msgid:${command.messageId}`, maxResults: '10' });
  return plan(command, 'gmail', 'GET', `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query.toString()}`, null);
}

export function graphProtocolRequest(command: GatewayCommand): ProtocolRequest {
  if (command.kind === 'send') {
    validateSend(command);
    return plan(command, 'graph', 'POST', 'https://graph.microsoft.com/v1.0/me/sendMail', {
      message: { subject: command.envelope.subject, body: { contentType: 'Text', content: command.envelope.body },
        toRecipients: [{ emailAddress: { address: command.envelope.to } }],
        internetMessageHeaders: [{ name: 'x-accountability-handoff', value: command.id }] }, saveToSentItems: true,
    });
  }
  validateReconcile(command);
  const query = new URLSearchParams({ '$select': 'id,internetMessageId,internetMessageHeaders,sentDateTime', '$top': '50' });
  return plan(command, 'graph', 'GET', `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?${query.toString()}`, null);
}

function validateReconcile(command: GatewayReconcileCommand): void {
  invariant(/^[a-f0-9]{64}$/.test(command.handoffId) && command.retryPolicy === 'read-only', 'invalid_gateway_command', 'Invalid reconciliation command');
  validateMessageHeaders({ messageId: command.messageId, inReplyTo: null, references: [] }); isoTime(command.since);
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function safeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return providerIdentifier(value); } catch { return null; }
}

/** Raw error bodies are deliberately excluded. Transport failures/5xx never establish non-acceptance. */
export function parseProviderSendResponse(provider: 'gmail' | 'graph', status: number, body: unknown): ProviderOutcome {
  if (provider === 'graph' && status === 202) return { kind: 'accepted', providerMessageId: null };
  if (provider === 'gmail' && status === 200) {
    const id = safeProviderId(object(body)?.id);
    return id ? { kind: 'accepted', providerMessageId: id } : { kind: 'unknown' };
  }
  if (status === 401) return { kind: 'rejected', code: 'auth-denied' };
  if (status === 403) return { kind: 'rejected', code: 'policy-denied' };
  // Conservative even on malformed success and throttling: the gateway must not guess at delivery.
  return { kind: 'unknown' };
}

/** Accepts authenticated provider records, not incoming mail claims. Missing/search-only evidence stays uncertain. */
export function reconcileProviderRecords(command: GatewayReconcileCommand, records: readonly unknown[]): ProviderOutcome {
  validateReconcile(command);
  const matches: string[] = [];
  for (const raw of records) {
    const record = object(raw); if (!record) continue;
    const id = safeProviderId(record.id); if (!id) continue;
    let matched = false;
    if (command.provider === 'gmail') {
      const payload = object(record.payload);
      const headers = Array.isArray(payload?.headers) ? payload.headers : [];
      matched = Array.isArray(record.labelIds) && record.labelIds.includes('SENT')
        && headers.some(rawHeader => { const header = object(rawHeader); return typeof header?.name === 'string'
          && header.name.toLowerCase() === 'message-id' && header.value === command.messageId; })
        && headers.some(rawHeader => { const header = object(rawHeader); return typeof header?.name === 'string'
          && header.name.toLowerCase() === 'x-accountability-handoff' && header.value === command.handoffId; });
    } else if (command.provider === 'graph') {
      const headers = Array.isArray(record.internetMessageHeaders) ? record.internetMessageHeaders : [];
      matched = typeof record.sentDateTime === 'string' && Number.isFinite(Date.parse(record.sentDateTime))
        && Date.parse(record.sentDateTime) >= Date.parse(command.since) - 60_000
        && headers.some(rawHeader => { const header = object(rawHeader); return typeof header?.name === 'string'
          && header.name.toLowerCase() === 'x-accountability-handoff' && header.value === command.handoffId; });
    }
    if (matched && !matches.includes(id)) matches.push(id);
  }
  // Multiple receipts require investigation, not arbitrarily choosing a sent message.
  return matches.length === 1 ? { kind: 'accepted', providerMessageId: matches[0]! } : { kind: 'unknown' };
}

export type FakeProviderBehavior = 'accept' | 'reject' | 'timeout-before-accept' | 'accept-then-timeout';
export type FakeProviderState = { attempts: { key: string; commandDigest: string; calls: number; outcome: ProviderOutcome; receipt: string | null }[] };
export function createFakeProviderState(): FakeProviderState { return { attempts: [] }; }

/** Deterministic provider simulator. Even its timeout cases perform no I/O. */
export function applyFakeProvider(original: FakeProviderState, command: GatewayCommand, behavior: FakeProviderBehavior = 'accept'): {
  state: FakeProviderState; outcome: ProviderOutcome;
} {
  invariant(command.provider === 'fake', 'provider_mismatch', 'Fake provider accepts only fake commands');
  const state = structuredClone(original);
  const key = digest({ tenantId: command.tenantId, projectId: command.projectId, mailboxId: command.mailboxId,
    accountRef: command.accountRef, handoffId: command.kind === 'send' ? command.id : command.handoffId });
  const prior = state.attempts.find(attempt => attempt.key === key);
  if (command.kind === 'reconcile') {
    validateReconcile(command);
    return { state, outcome: prior?.receipt ? { kind: 'accepted', providerMessageId: prior.receipt } : { kind: 'unknown' } };
  }
  validateSend(command);
  if (prior) {
    invariant(prior.commandDigest === digest(command), 'fake_dispatch_conflict', 'Same handoff has different content');
    prior.calls += 1;
    return { state, outcome: structuredClone(prior.outcome) };
  }
  invariant(['accept', 'reject', 'timeout-before-accept', 'accept-then-timeout'].includes(behavior), 'invalid_fake_behavior', 'Unknown fake provider behavior');
  const receipt = behavior === 'accept' || behavior === 'accept-then-timeout' ? `fake-${command.id}` : null;
  const outcome: ProviderOutcome = behavior === 'accept' ? { kind: 'accepted', providerMessageId: receipt }
    : behavior === 'reject' ? { kind: 'rejected', code: 'not-accepted' } : { kind: 'unknown' };
  state.attempts.push({ key, commandDigest: digest(command), calls: 1, outcome, receipt });
  return { state, outcome: structuredClone(outcome) };
}
