import type { Context, Ref, Scope } from './contracts.ts';

export type Provider = 'fake' | 'gmail' | 'graph';
export type Control = 'human' | 'autonomous';
export type Epochs = { control: number; context: number; auth: number; suppression: number };
export type CorrespondenceRole = 'correspondence:read' | 'correspondence:write' | 'correspondence:control'
  | 'correspondence:authorize' | 'correspondence:gateway' | 'correspondence:ingress';
export type MailFolder = 'inbox' | 'archive' | 'trash' | 'spam';
export type MailView = MailFolder | 'all' | 'sent' | 'drafts' | 'unread' | 'starred';
export type MailboxLimits = {
  minimumCooldownMs: number; maxFollowups: number; maxGrantSends: number; maxGrantLifetimeMs: number;
};
export type MailboxConnection = {
  provider: Provider; accountRef: string; connectionRef: string; address: string;
};
export type Mailbox = {
  id: string; brand: string; contextLabel: string; control: Control; epochs: Epochs;
  connection: MailboxConnection | null; limits: MailboxLimits;
};
export type MailThread = {
  id: string; recipient: string; subject: string; folder: MailFolder; read: boolean; starred: boolean;
  contextEpoch: number; autonomyPaused: boolean; createdAt: string; lastActivityAt: string;
};
export type ResearchContent = { kind: 'research'; topic: string; questions: string[] };
export type HumanContent = { kind: 'human'; subject: string; body: string };
export type DraftContent = ResearchContent | HumanContent;
export type MailDraft = {
  id: string; threadId: string; version: number; authorId: string; authorKind: Context['actor']['kind'];
  content: DraftContent; subject: string; body: string; epochs: Epochs; threadContextEpoch: number;
  status: 'draft' | 'queued' | 'handed-off' | 'accepted' | 'discarded'; createdAt: string; updatedAt: string;
};
/** A local, human-issued capability. The parent authenticates the issuer and atomically persists usage. */
export type SendGrant = Scope & {
  id: string; mailboxId: string; mode: Control; actorIds: string[]; recipients: string[]; purpose: string;
  notBefore: string; expiresAt: string; maxSends: number; maxFollowups: number; cooldownMs: number;
  epochs: Epochs; issuedBy: string; issuedAt: string; status: 'active' | 'revoked'; usedSends: number;
};
export type GrantInput = Pick<SendGrant, 'id' | 'mode' | 'actorIds' | 'recipients' | 'purpose'
  | 'notBefore' | 'expiresAt' | 'maxSends' | 'maxFollowups' | 'cooldownMs'>;
export type Suppression = {
  address: string; reason: 'manual' | 'opt-out' | 'invalid-recipient'; active: boolean;
  recordedAt: string; recordedBy: string; liftedAt: string | null; consentNote: string | null;
};
export type MessageHeaders = { messageId: string | null; inReplyTo: string | null; references: string[] };
export type InboundEvidence = {
  verification: 'unverified'; policyAuthority: false; attributedSender: string;
  source: 'provider-ingress'; provider: Provider; accountRef: string; providerMessageId: string;
  ingressFingerprint: string; providerKey: string;
};
export type MailMessage = Ref & {
  kind: 'correspondence-message'; threadId: string; direction: 'inbound' | 'outbound';
  from: string; to: string; subject: string; body: string; at: string; headers: MessageHeaders;
  evidence: InboundEvidence | null; providerMessageId: string | null;
  delivery: 'received-unverified' | 'provider-accepted'; intentId: string | null;
};
export type DispatchFence = Epochs & { threadContextEpoch: number; draftVersion: number; grantId: string };
export type SendEnvelope = { from: string; to: string; subject: string; body: string; headers: MessageHeaders };
export type GatewaySendCommand = Scope & {
  kind: 'send'; id: string; mailboxId: string; intentId: string; provider: Provider;
  accountRef: string; connectionRef: string; authEpoch: number; commitRevision: number;
  at: string; fence: DispatchFence; envelope: SendEnvelope; retryPolicy: 'never-blind-retry';
};
export type GatewayReconcileCommand = Scope & {
  kind: 'reconcile'; id: string; mailboxId: string; intentId: string; handoffId: string;
  provider: Provider; accountRef: string; connectionRef: string; authEpoch: number;
  messageId: string; since: string; retryPolicy: 'read-only';
};
export type GatewayCommand = GatewaySendCommand | GatewayReconcileCommand;
export type ProviderOutcome =
  | { kind: 'accepted'; providerMessageId: string | null }
  | { kind: 'rejected'; code: 'invalid-recipient' | 'auth-denied' | 'policy-denied' | 'not-accepted' }
  | { kind: 'unknown' };
export type DispatchTicket = { id: string; expiresAt: string; fence: DispatchFence };
export type HandoffMarker = { id: string; at: string; commandDigest: string; command: GatewaySendCommand };
export type OutboundIntent = {
  id: string; threadId: string; draftId: string; draftVersion: number; draftDigest: string; grantId: string;
  mode: Control; actorId: string; purpose: string; recipient: string; fence: DispatchFence; createdAt: string;
  status: 'queued' | 'prepared' | 'cancelled' | 'handed-off' | 'uncertain' | 'accepted' | 'rejected';
  ticket: DispatchTicket | null; handoff: HandoffMarker | null; outcome: ProviderOutcome | null;
  cancellationReason: string | null; uncertainty: 'timeout' | 'crash' | 'transport' | null;
  reconcileRequests: number; lastReconcileAt: string | null;
};
export type CorrespondenceResult = {
  entityId: string; status: string; ticketId: string | null; duplicateEvidence: boolean;
  cancelledIntentIds: string[]; unrecallableIntentIds: string[];
};
export type CorrespondenceReceipt = { inputId: string; fingerprint: string; result: CorrespondenceResult };
export type CorrespondenceEvent = {
  sequence: number; inputId: string; requestId: string; actorId: string; at: string; type: string;
  entityId: string; status: string;
};
export type CorrespondenceState = Scope & {
  schemaVersion: 1; revision: number; createdAt: string; updatedAt: string; mailbox: Mailbox;
  threads: MailThread[]; drafts: MailDraft[]; messages: MailMessage[]; grants: SendGrant[];
  suppressions: Suppression[]; intents: OutboundIntent[]; receipts: CorrespondenceReceipt[];
  events: CorrespondenceEvent[];
};
export type CorrespondenceTransition = {
  state: CorrespondenceState; result: CorrespondenceResult; gatewayCommands: GatewayCommand[]; duplicate: boolean;
};
export type CorrespondenceCommand = { inputId: string } & (
  | { type: 'createThread'; threadId: string; recipient: string; subject: string }
  | { type: 'createDraft'; draftId: string; threadId: string; content: DraftContent }
  | { type: 'reviseDraft'; draftId: string; expectedVersion: number; content: DraftContent }
  | { type: 'discardDraft'; draftId: string; expectedVersion: number }
  | { type: 'setControl'; mode: Control }
  | { type: 'setResearchContext'; contextLabel: string }
  | { type: 'connectMailbox'; connection: MailboxConnection }
  | { type: 'disconnectMailbox' }
  | { type: 'issueGrant'; grant: GrantInput }
  | { type: 'revokeGrant'; grantId: string }
  | { type: 'suppressRecipient'; address: string; reason: 'manual' | 'opt-out' }
  | { type: 'liftSuppression'; address: string; consentNote: string }
  | { type: 'queueDraft'; draftId: string; expectedVersion: number; intentId: string; grantId: string }
  | { type: 'cancelIntent'; intentId: string }
  | { type: 'prepareDispatch'; intentId: string }
  | { type: 'handoff'; intentId: string; ticketId: string }
  | { type: 'markUncertain'; intentId: string; handoffId: string; reason: 'timeout' | 'crash' | 'transport' }
  | { type: 'recordOutcome'; intentId: string; handoffId: string; outcome: ProviderOutcome }
  | { type: 'requestReconciliation'; intentId: string }
  | { type: 'ingestReply'; threadId: string; createThread?: boolean; provider: Provider; accountRef: string; authEpoch: number;
      providerMessageId: string; from: string; to: string; subject: string; body: string; headers: MessageHeaders }
  | { type: 'setThreadFlags'; threadId: string; folder?: MailFolder; read?: boolean; starred?: boolean }
  | { type: 'resumeThread'; threadId: string }
);
export type MailThreadView = MailThread & { messageCount: number; draftCount: number; pendingCount: number; preview: string };
export type MailPage = { threads: MailThreadView[]; total: number; nextOffset: number | null };
export type ReplyEvidence = { ref: Ref; verification: 'unverified'; policyAuthority: false; attributedSender: string;
  subject: string; body: string; receivedAt: string; provider: Provider; providerMessageId: string };
