import { digest, invariant } from './contracts.ts';
import { createHash } from 'node:crypto';
import { normalizeAddress, safeBody, safeHeader, validateMessageHeaders } from './validation.ts';
import type { MailboxSyncLimits, NormalizedMailboxMessage, QuarantinedContent, SyncBinding } from './sync-types.ts';
import type { MessageHeaders } from './types.ts';

export function object(value: unknown): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'sync_invalid_response', 'Expected a provider object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 512): string {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value),
    'sync_invalid_response', 'Invalid provider text field');
  return value;
}
export function list(value: unknown, max: number, optional = false): unknown[] {
  if (value === undefined && optional) return [];
  invariant(Array.isArray(value) && value.length <= max, 'sync_page_limit', 'Provider array exceeds its bound');
  return value;
}
export function historyId(value: unknown): string {
  const id = text(value, 30); invariant(/^[1-9][0-9]*$/.test(id), 'sync_invalid_response', 'Invalid Gmail history ID'); return id;
}
export function providerMessageId(value: unknown): string {
  const id = text(value); invariant(/^[A-Za-z0-9_+=./:@-]+$/.test(id), 'sync_invalid_response', 'Invalid provider message ID'); return id;
}
export function providerKey(binding: SyncBinding, id: string): string {
  return digest({ provider: binding.provider, accountRef: binding.accountRef, providerMessageId: id });
}
function quarantine(id: string, reason: QuarantinedContent['reason'], mediaType: string, bytes: Uint8Array | null, size = bytes?.byteLength ?? 0): QuarantinedContent {
  const sha256 = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  return { key: digest({ id, reason, mediaType, sha256, size }), providerMessageId: id, reason, mediaType,
    byteLength: size, sha256, contentBase64: bytes && bytes.byteLength <= 65_536 ? Buffer.from(bytes).toString('base64') : null };
}
export function invalidMessage(id: string): QuarantinedContent { return quarantine(id, 'invalid-message', 'application/octet-stream', null); }
export function changedEvidence(id: string): QuarantinedContent { return quarantine(id, 'changed-evidence', 'text/plain', null); }
function bareAddress(value: unknown): string {
  const raw = text(value, 320).trim();
  // Display names are data; only one unambiguous address is accepted.
  const match = raw.match(/^[^<>]*<([^<>]+)>$/);
  return normalizeAddress(match?.[1] ?? raw);
}
function mailHeaders(value: unknown): { get: (name: string) => string | null; headers: MessageHeaders } {
  const entries = list(value, 100, true).map(object);
  const get = (name: string): string | null => {
    const matches = entries.filter(item => typeof item.name === 'string' && item.name.toLowerCase() === name);
    invariant(matches.length <= 1, 'sync_invalid_message', 'Ambiguous mail header');
    return matches.length ? text(matches[0]!.value, 6000) : null;
  };
  const references = get('references')?.trim().split(/\s+/) ?? [];
  const headers = validateMessageHeaders({ messageId: get('message-id'), inReplyTo: get('in-reply-to'), references });
  return { get, headers };
}
function boundedText(value: string, limits: MailboxSyncLimits): string {
  invariant(Buffer.byteLength(value) <= limits.maxTextBytes, 'sync_message_too_large', 'Plain text exceeds the configured limit');
  return safeBody(value || '[No plain text content; non-text content is quarantined.]');
}
function decodeData(value: unknown, max: number): Buffer {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(value) && value.length <= Math.ceil(max * 4 / 3) + 4,
    'sync_invalid_message', 'Invalid or oversized Gmail body encoding');
  const bytes = Buffer.from(value, 'base64url');
  invariant(bytes.byteLength <= max && bytes.toString('base64url') === value.replace(/=+$/, ''), 'sync_invalid_message', 'Invalid Gmail body encoding');
  return bytes;
}
export function normalizeGmailMessage(raw: unknown, limits: MailboxSyncLimits): NormalizedMailboxMessage {
  const message = object(raw); const id = providerMessageId(message.id); const payload = object(message.payload);
  const { get, headers } = mailHeaders(payload.headers);
  const parts: string[] = []; const isolated: QuarantinedContent[] = []; let count = 0; let total = 0;
  function walk(rawPart: unknown, depth: number): void {
    invariant(depth <= 10 && ++count <= 100, 'sync_invalid_message', 'MIME tree exceeds its bound');
    const part = object(rawPart); const body = part.body === undefined ? {} : object(part.body);
    const mediaType = text(part.mimeType, 120).toLowerCase();
    const declaredSize = body.size ?? 0;
    invariant(Number.isSafeInteger(declaredSize) && (declaredSize as number) >= 0, 'sync_invalid_message', 'Invalid MIME part size');
    const disposition = list(part.headers, 100, true).map(object).some(header =>
      typeof header.name === 'string' && header.name.toLowerCase() === 'content-disposition'
      && typeof header.value === 'string' && /^(attachment|inline)/i.test(header.value));
    const attachment = (typeof part.filename === 'string' && part.filename.length > 0) || body.attachmentId !== undefined || disposition;
    if (attachment) {
      isolated.push(quarantine(id, 'attachment', mediaType, null, declaredSize as number)); return;
    }
    if (mediaType.startsWith('multipart/')) {
      for (const child of list(part.parts, 100, true)) walk(child, depth + 1);
      return;
    }
    if (body.data === undefined) return;
    const bytes = decodeData(body.data, limits.maxMessageBytes); total += bytes.byteLength;
    invariant(total <= limits.maxMessageBytes, 'sync_message_too_large', 'Message content exceeds the configured limit');
    if (mediaType === 'text/plain') {
      // Unspecified charsets default to UTF-8 for this bounded SDK. Unsupported encodings are quarantined.
      const contentType = list(part.headers, 100, true).map(object).find(h => typeof h.name === 'string' && h.name.toLowerCase() === 'content-type');
      const charset = typeof contentType?.value === 'string' ? contentType.value.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1]?.toLowerCase() : undefined;
      if (charset && !['utf-8', 'us-ascii'].includes(charset)) isolated.push(quarantine(id, 'unsupported-content', mediaType, bytes));
      else parts.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } else isolated.push(quarantine(id, mediaType === 'text/html' ? 'html' : 'unsupported-content', mediaType, bytes));
  }
  walk(payload, 0);
  const labels = list(message.labelIds, 100, true).map(item => text(item, 160));
  return { providerMessageId: id, providerThreadId: providerMessageId(message.threadId),
    from: bareAddress(get('from')), to: text(get('to'), 2000).split(',').map(bareAddress),
    subject: safeHeader(get('subject') ?? '(no subject)'), text: boundedText(parts.join('\n'), limits), headers,
    read: !labels.includes('UNREAD'), labels, draft: labels.includes('DRAFT'), sent: labels.includes('SENT'), quarantine: isolated };
}
export function normalizeGraphMessage(raw: unknown, limits: MailboxSyncLimits): NormalizedMailboxMessage {
  const message = object(raw); const id = providerMessageId(message.id); const body = object(message.body);
  const kind = text(body.contentType, 40).toLowerCase();
  invariant(typeof body.content === 'string' && Buffer.byteLength(body.content) <= limits.maxMessageBytes,
    'sync_message_too_large', 'Message content exceeds the configured limit');
  const isolated: QuarantinedContent[] = [];
  if (kind !== 'text') isolated.push(quarantine(id, kind === 'html' ? 'html' : 'unsupported-content', `text/${kind}`, Buffer.from(body.content)));
  invariant(typeof message.hasAttachments === 'boolean' && typeof message.isRead === 'boolean' && typeof message.isDraft === 'boolean',
    'sync_invalid_message', 'Missing provider message flags');
  if (message.hasAttachments) isolated.push(quarantine(id, 'attachment', 'application/octet-stream', null));
  const { headers } = mailHeaders(message.internetMessageHeaders);
  const from = object(object(message.from).emailAddress);
  const to = list(message.toRecipients, 100).map(item => normalizeAddress(text(object(object(item).emailAddress).address, 254)));
  const internetMessageId = message.internetMessageId;
  if (internetMessageId !== undefined) headers.messageId = validateMessageHeaders({ ...headers, messageId: text(internetMessageId, 254) }).messageId;
  return { providerMessageId: id, providerThreadId: providerMessageId(message.conversationId), from: normalizeAddress(text(from.address, 254)), to,
    subject: safeHeader(typeof message.subject === 'string' && message.subject.trim() ? message.subject : '(no subject)'),
    text: boundedText(kind === 'text' ? body.content : '', limits), headers, read: message.isRead, labels: [],
    draft: message.isDraft, sent: false, quarantine: isolated };
}
