import { DomainError, invariant } from './contracts.ts';
import type { ReadOnlyMailboxTransport, ReadRequest, ReadResponse, MailboxSyncLimits, SyncBinding } from './sync-types.ts';
import { object, text } from './sync-content.ts';

export const DEFAULT_SYNC_LIMITS: Readonly<MailboxSyncLimits> = Object.freeze({
  maxPages: 2, pageSize: 25, maxChanges: 100, maxResponseBytes: 262_144,
  maxBatchBytes: 1_048_576, maxMessageBytes: 131_072, maxTextBytes: 20_000, maxRecords: 10_000, timeoutMs: 15_000,
});
export function syncLimits(overrides: Partial<MailboxSyncLimits> = {}): MailboxSyncLimits {
  invariant(Object.keys(overrides).every(key => Object.hasOwn(DEFAULT_SYNC_LIMITS, key)), 'sync_invalid_limit', 'Unknown sync limit');
  const limits = { ...DEFAULT_SYNC_LIMITS, ...overrides };
  const maximum: MailboxSyncLimits = { maxPages: 10, pageSize: 100, maxChanges: 500, maxResponseBytes: 2_097_152,
    maxBatchBytes: 8_388_608, maxMessageBytes: 1_048_576, maxTextBytes: 20_000, maxRecords: 50_000, timeoutMs: 60_000 };
  for (const key of Object.keys(limits) as (keyof MailboxSyncLimits)[]) {
    invariant(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= maximum[key], 'sync_invalid_limit', 'Sync limit is outside its bound');
  }
  return limits;
}
export function gmailRoot(binding: SyncBinding): string {
  return `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(binding.providerAccountId)}`;
}
export function graphRoot(binding: SyncBinding): string {
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(binding.providerAccountId)}`;
}
export function graphDeltaPath(binding: SyncBinding): string {
  return new URL(`${graphRoot(binding)}/mailFolders/${encodeURIComponent(binding.folderId!)}/messages/delta`).pathname;
}
export function graphCursorUrl(binding: SyncBinding, value: unknown): string {
  const raw = text(value, 8192);
  let url: URL;
  try { url = new URL(raw); } catch { throw new DomainError('sync_unsafe_cursor', 'Invalid Graph continuation URL'); }
  invariant(url.origin === 'https://graph.microsoft.com' && url.pathname === graphDeltaPath(binding)
    && url.username === '' && url.password === '' && url.hash === '' && raw.startsWith('https://graph.microsoft.com/'),
    'sync_unsafe_cursor', 'Graph continuation escaped its bound account or folder');
  const allowed = ['$select', '$top', '$skiptoken', '$deltatoken'];
  invariant([...url.searchParams.keys()].every(key => allowed.includes(key))
    && [...new Set(url.searchParams.keys())].every(key => url.searchParams.getAll(key).length === 1)
    && (url.searchParams.has('$skiptoken') !== url.searchParams.has('$deltatoken')),
    'sync_unsafe_cursor', 'Graph continuation contains unexpected query fields');
  return raw; // Opaque state URLs are used verbatim after validation.
}

/** Byte and wall-time limits apply even when a transport fails to enforce its own cap. */
export async function readBoundedJson(transport: ReadOnlyMailboxTransport, request: ReadRequest): Promise<{ status: number; value: unknown; errorCode?: 'syncStateNotFound' }> {
  invariant(request.method === 'GET' && request.redirect === 'error', 'sync_read_only', 'Only nonredirecting reads are allowed');
  syncLimits({ maxResponseBytes: request.maxResponseBytes, timeoutMs: request.timeoutMs });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new DomainError('sync_timeout', 'Mailbox read timed out')); }, request.timeoutMs);
  });
  try {
    const execute = async () => {
      let response: ReadResponse;
      try { response = await transport.read({ ...request, signal: controller.signal }); }
      catch { throw new DomainError('sync_transport_failed', 'Mailbox read transport failed'); }
      invariant(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599,
        'sync_invalid_response', 'Invalid provider status');
      const chunks: Uint8Array[] = []; let size = 0; let invalid = false; let oversized = false; let chunkCount = 0; let fragmented = false;
      try {
        for await (const chunk of response.body) {
          if (++chunkCount > 4096) { fragmented = true; break; }
          if (!(chunk instanceof Uint8Array)) { invalid = true; break; }
          size += chunk.byteLength;
          if (size > request.maxResponseBytes) { oversized = true; break; }
          chunks.push(Uint8Array.from(chunk));
        }
      } catch { throw new DomainError('sync_transport_failed', 'Mailbox read body failed'); }
      invariant(!fragmented, 'sync_response_too_fragmented', 'Mailbox response exceeds its chunk bound');
      invariant(!invalid, 'sync_invalid_response', 'Mailbox response must contain bytes');
      invariant(!oversized, 'sync_response_too_large', 'Mailbox response exceeds the configured limit');
      // Never retain or propagate provider error bodies, headers, locations or exception messages.
      if (response.status !== 200) {
        let stale = false;
        if (transport.binding.provider === 'graph' && [400, 404, 410].includes(response.status)) {
          try { const raw = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); stale = String(object(raw.error).code).toLowerCase() === 'syncstatenotfound'; } catch { /* Discard all raw error content. */ }
        }
        return stale ? { status: response.status, value: null, errorCode: 'syncStateNotFound' as const } : { status: response.status, value: null };
      }
      try { return { status: response.status, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown }; }
      catch { throw new DomainError('sync_invalid_json', 'Mailbox response is not valid UTF-8 JSON'); }
    };
    return await Promise.race([execute(), expired]);
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
export async function getJson(transport: ReadOnlyMailboxTransport, url: string, limits: MailboxSyncLimits, message = false) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (transport.binding.provider === 'graph') headers.Prefer = `IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=${limits.pageSize}`;
  return readBoundedJson(transport, { method: 'GET', url, headers, maxResponseBytes: message
    ? Math.min(limits.maxResponseBytes, limits.maxMessageBytes) : limits.maxResponseBytes, redirect: 'error', timeoutMs: limits.timeoutMs });
}
export function successful(response: { status: number; value: unknown }): Record<string, unknown> {
  invariant(response.status === 200, response.status === 401 || response.status === 403 ? 'sync_auth_denied' : 'sync_http_failed', 'Mailbox provider read was not successful');
  return object(response.value);
}
