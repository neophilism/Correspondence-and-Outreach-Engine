import { invariant, nonempty, validTime } from './contracts.ts';
import type { DraftContent, MessageHeaders, Provider } from './types.ts';

export function safeHeader(value: string, label = 'Header', max = 200): string {
  nonempty(value, label, max);
  invariant(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value), 'unsafe_header', 'Header contains control characters');
  return value.trim();
}

/** Deliberately accepts only single, bare ASCII addresses; aliases and display names require separate resolution. */
export function normalizeAddress(value: string): string {
  safeHeader(value, 'Address', 254);
  invariant(value === value.trim() && /^[\x21-\x7e]+$/.test(value), 'invalid_address', 'A bare ASCII address is required');
  const parts = value.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  invariant(parts.length === 2 && local.length <= 64 && local.length > 0
    && /^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local)
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..'), 'invalid_address', 'Invalid local address');
  const labels = domain.split('.');
  invariant(domain.length <= 253 && labels.length >= 2 && labels.every(label =>
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)), 'invalid_address', 'Invalid address domain');
  // Conservative case-insensitive suppression/dedup identity, including the local part.
  return value.toLowerCase();
}

export function identifier(value: string, label = 'Identifier'): string {
  nonempty(value, label, 160);
  invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value), 'invalid_identifier', 'Invalid opaque identifier');
  return value;
}

export function providerIdentifier(value: string): string {
  nonempty(value, 'Provider identifier', 512);
  invariant(/^[A-Za-z0-9_+=./:@-]+$/.test(value), 'invalid_identifier', 'Invalid provider identifier');
  return value;
}

export function provider(value: Provider): Provider {
  invariant(['fake', 'gmail', 'graph'].includes(value), 'invalid_provider', 'Unsupported provider');
  return value;
}

export function isoTime(value: string): string {
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value),
    'invalid_time', 'An explicit UTC timestamp is required');
  const normalized = new Date(validTime(value)).toISOString();
  invariant(normalized.slice(0, 19) === value.slice(0, 19), 'invalid_time', 'Timestamp does not identify a calendar time');
  return normalized;
}

export function safeBody(value: string): string {
  nonempty(value, 'Body', 20_000);
  invariant(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'invalid_body', 'Body contains control characters');
  return value.replace(/\r\n?/g, '\n');
}

function messageId(value: string | null): string | null {
  if (value === null) return null;
  safeHeader(value, 'Message ID', 254);
  invariant(/^<[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+>$/.test(value), 'invalid_message_id', 'Invalid message ID');
  return value;
}

export function validateMessageHeaders(headers: MessageHeaders): MessageHeaders {
  invariant(Object.keys(headers).every(key => ['messageId', 'inReplyTo', 'references'].includes(key)), 'unsafe_header', 'Unexpected mail header');
  invariant(Array.isArray(headers.references) && headers.references.length <= 20, 'invalid_header', 'Too many references');
  return { messageId: messageId(headers.messageId), inReplyTo: messageId(headers.inReplyTo), references: headers.references.map(value => {
    invariant(value !== null, 'invalid_message_id', 'Reference must be a message ID');
    return messageId(value)!;
  }) };
}

export function renderResearchInquiry(input: { brand: string; topic: string; questions: readonly string[] }): { subject: string; body: string } {
  const brand = safeHeader(input.brand, 'Brand', 60);
  invariant(/^[\p{L}\p{N}][\p{L}\p{N} .&'-]*$/u.test(brand), 'invalid_brand', 'Brand must be a short display label');
  const topic = safeHeader(input.topic, 'Research topic', 120);
  invariant(Array.isArray(input.questions) && input.questions.length >= 1 && input.questions.length <= 3,
    'invalid_questions', 'An inquiry needs one to three questions');
  const questions = input.questions.map(question => {
    const safe = safeHeader(question, 'Research question', 240);
    invariant(safe.endsWith('?') && (safe.match(/\?/g)?.length ?? 0) === 1, 'invalid_questions', 'Each item must contain one question');
    return safe;
  });
  return {
    subject: `Research inquiry: ${topic}`,
    body: `Hello,\n\nThis is an automated research inquiry from ${brand}.\n\nTopic: ${topic}\n\n`
      + questions.map((question, i) => `${i + 1}. ${question}`).join('\n')
      + '\n\nParticipation is optional. Please share only information you are authorized to share. To stop further inquiries, reply STOP.',
  };
}

export function renderContent(brand: string, content: DraftContent): { subject: string; body: string } {
  if (content.kind === 'research') return renderResearchInquiry({ brand, topic: content.topic, questions: content.questions });
  invariant(content.kind === 'human', 'invalid_content', 'Unsupported draft content');
  return { subject: safeHeader(content.subject, 'Subject'), body: safeBody(content.body) };
}

export function detectsOptOut(body: string): boolean {
  const first = body.trim().split('\n')[0]?.trim() ?? '';
  return /^(?:stop|unsubscribe|remove me|please stop|do not contact me|please do not contact me)[.!]?$/i.test(first);
}
