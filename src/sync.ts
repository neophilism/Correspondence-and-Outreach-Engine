import { digest, invariant, requireScope } from './contracts.ts';
import type { Scope } from './contracts.ts';
import type { CorrespondenceState } from './types.ts';
import { normalizeAddress } from './validation.ts';

/** Public routing data only. The injected transport owns all authentication material. */
export type SyncBinding = Scope & {
  mailboxId: string; provider: 'gmail' | 'graph'; accountRef: string; authEpoch: number;
  address: string; providerAccountId: string; folderId: string | null;
};
export type ReadRequest = {
  method: 'GET'; url: string; headers: Readonly<Record<string, string>>;
  maxResponseBytes: number; redirect: 'error';
};
export type ReadResponse = { status: number; body: AsyncIterable<Uint8Array> };
/** Implementations must bind credentials to this exact identity, disable redirects and cap streaming bytes. */
export type ReadOnlyMailboxTransport = {
  binding: SyncBinding;
  read(request: ReadRequest): Promise<ReadResponse>;
};
export type SyncCursor =
  | { kind: 'gmail-full'; pageToken: string | null; baselineHistoryId: string }
  | { kind: 'gmail-history'; historyId: string; pageToken: string | null }
  | { kind: 'graph-delta'; url: string };
export type SyncCheckpoint = { binding: SyncBinding; revision: number; cursor: SyncCursor | null };

export function assertSyncBinding(state: CorrespondenceState, binding: SyncBinding, transport: ReadOnlyMailboxTransport): void {
  requireScope(binding, state);
  const connection = state.mailbox.connection;
  invariant(state.mailbox.id === binding.mailboxId && connection?.provider === binding.provider
    && connection.accountRef === binding.accountRef && state.mailbox.epochs.auth === binding.authEpoch
    && connection.address === normalizeAddress(binding.address), 'sync_fenced', 'Mailbox synchronization identity is stale');
  invariant(digest(transport.binding) === digest(binding), 'sync_transport_mismatch', 'Transport belongs to another mailbox identity');
}

/** A byte cap is applied before JSON parsing; raw provider errors never escape to logs through SDK errors. */
export async function readBoundedJson(transport: ReadOnlyMailboxTransport, request: ReadRequest): Promise<{ status: number; value: unknown }> {
  let response: ReadResponse;
  try { response = await transport.read(request); }
  catch { throw new Error('Mailbox read transport failed'); }
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      invariant(chunk instanceof Uint8Array, 'sync_invalid_response', 'Mailbox response must contain bytes');
      size += chunk.byteLength;
      invariant(size <= request.maxResponseBytes, 'sync_response_too_large', 'Mailbox response exceeds the configured limit');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'DomainError') throw error;
    throw new Error('Mailbox read body failed');
  }
  if (response.status !== 200) return { status: response.status, value: null };
  try { return { status: response.status, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { throw new Error('Mailbox response is not valid JSON'); }
}
