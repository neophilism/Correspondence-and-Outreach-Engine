import type { Context, Scope } from './contracts.ts';
import type { CorrespondenceState, MessageHeaders } from './types.ts';

/** Routing metadata only; credentials must remain private to the transport. */
export type SyncBinding = Scope & {
  mailboxId: string; provider: 'gmail' | 'graph'; accountRef: string; authEpoch: number;
  address: string; providerAccountId: string; folderId: string | null;
};
export type ReadRequest = {
  method: 'GET'; url: string; headers: Readonly<Record<string, string>>;
  maxResponseBytes: number; redirect: 'error'; timeoutMs: number; signal?: AbortSignal;
};
export type ReadResponse = { status: number; body: AsyncIterable<Uint8Array> };
export type ReadOnlyMailboxTransport = { binding: SyncBinding; read(request: ReadRequest): Promise<ReadResponse> };
export type SyncCursor =
  | { kind: 'gmail-full'; pageToken: string; baselineHistoryId: string; generation: string }
  | { kind: 'gmail-history'; historyId: string; pageToken: string | null }
  | { kind: 'graph-delta'; url: string; phase: 'next' | 'delta'; generation: string | null };
export type SyncCheckpoint = { binding: SyncBinding; revision: number; cursor: SyncCursor | null };
export type QuarantinedContent = {
  key: string; providerMessageId: string; reason: 'html' | 'attachment' | 'unsupported-content' | 'invalid-message' | 'changed-evidence';
  mediaType: string; byteLength: number; sha256: string | null; contentBase64: string | null;
};
export type NormalizedMailboxMessage = {
  providerMessageId: string; providerThreadId: string; from: string; to: string[];
  subject: string; text: string; headers: MessageHeaders; read: boolean;
  labels: string[]; draft: boolean; sent: boolean; quarantine: QuarantinedContent[];
};
export type SyncedRecord = {
  key: string; providerMessageId: string; deleted: boolean; seenGeneration: string | null;
  message: NormalizedMailboxMessage | null; ingestedMessageId: string | null;
};
export type MailboxSyncState = SyncCheckpoint & { records: SyncedRecord[]; quarantine: QuarantinedContent[] };
export type MailboxSyncSnapshot = { sync: MailboxSyncState; correspondence: CorrespondenceState };
/** One durable transaction must compare BOTH revisions and persist the ENTIRE next snapshot atomically. */
export type MailboxSyncStore = {
  load(binding: SyncBinding): Promise<MailboxSyncSnapshot>;
  commit(input: { binding: SyncBinding; expectedSyncRevision: number; expectedCorrespondenceRevision: number;
    next: MailboxSyncSnapshot }): Promise<boolean>;
};
export type MailboxSyncLimits = {
  maxPages: number; pageSize: number; maxChanges: number; maxResponseBytes: number;
  maxBatchBytes: number; maxMessageBytes: number; maxTextBytes: number; maxRecords: number; timeoutMs: number;
};
export type SyncPage = {
  changes: { id: string; message: NormalizedMailboxMessage | null; invalid: boolean }[];
  cursor: SyncCursor; generation: string | null; completeGeneration: boolean; more: boolean; reset: boolean;
};
export type MailboxSyncResult = { pagesCommitted: number; ingested: number; quarantined: number; resyncs: number; more: boolean };
export type SyncInvocation = { context: Context; binding: SyncBinding; transport: ReadOnlyMailboxTransport; store: MailboxSyncStore;
  limits?: Partial<MailboxSyncLimits> };
