export * from './types.ts';
export { createCorrespondenceState, transitionCorrespondence, assertCommittedHandoff, DEFAULT_MAILBOX_LIMITS } from './machine.ts';
export { normalizeAddress, safeHeader, validateMessageHeaders, renderResearchInquiry, detectsOptOut } from './validation.ts';
export { projectMail, projectThread, projectReplyEvidence } from './projections.ts';
export { encodeRfc5322, gmailProtocolRequest, graphProtocolRequest, parseProviderSendResponse,
  reconcileProviderRecords, createFakeProviderState, applyFakeProvider } from './adapters.ts';
export type { ProtocolRequest, FakeProviderBehavior, FakeProviderState } from './adapters.ts';
export { createAlphaCorrespondenceFixture } from './fixture.ts';
export { assertSyncBinding, createMailboxSyncState, synchronizeMailbox, DEFAULT_SYNC_LIMITS } from './sync.ts';
export type * from './sync-types.ts';
