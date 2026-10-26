import { invariant, requireScope } from './contracts.ts';
import type { Context } from './contracts.ts';
import type { CorrespondenceState, MailDraft, MailMessage, MailPage, MailThread, MailThreadView, MailView, ReplyEvidence } from './types.ts';

function readAccess(state: CorrespondenceState, ctx: Context, humanOnly: boolean): void {
  requireScope(ctx, state);
  invariant(!humanOnly || ctx.actor.kind === 'human', 'actor_denied', 'Ordinary mailbox views require a human');
  invariant(ctx.actor.roles.includes('correspondence:read') || (ctx.actor.kind === 'human' && ctx.actor.roles.includes('correspondence:admin')),
    'permission_denied', 'Correspondence read permission is required');
}

/** A pure local projection. Flags do not pretend to synchronize provider folders. No credentials or grants are returned. */
export function projectMail(state: CorrespondenceState, ctx: Context,
  options: { view?: MailView; query?: string; offset?: number; limit?: number } = {}): MailPage {
  readAccess(state, ctx, true);
  const view = options.view ?? 'inbox'; const offset = options.offset ?? 0; const limit = options.limit ?? 50;
  invariant(['inbox', 'archive', 'trash', 'spam', 'all', 'sent', 'drafts', 'unread', 'starred'].includes(view), 'invalid_folder', 'Unknown mail view');
  invariant(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
    'invalid_pagination', 'Invalid mailbox page');
  invariant(typeof (options.query ?? '') === 'string' && (options.query?.length ?? 0) <= 200, 'invalid_query', 'Search query is too long');
  const query = (options.query ?? '').trim().toLowerCase();
  const threads: MailThreadView[] = [];
  for (const thread of state.threads) {
    const messages = state.messages.filter(message => message.threadId === thread.id);
    const drafts = state.drafts.filter(draft => draft.threadId === thread.id && (draft.status === 'draft' || draft.status === 'queued'));
    if (view !== 'all' && view !== 'trash' && view !== 'spam' && ['trash', 'spam'].includes(thread.folder)) continue;
    let matches: boolean;
    switch (view) {
      case 'all': matches = true; break;
      case 'drafts': matches = drafts.length > 0; break;
      case 'sent': matches = messages.some(message => message.direction === 'outbound'); break;
      case 'unread': matches = !thread.read; break;
      case 'starred': matches = thread.starred; break;
      default: matches = thread.folder === view;
    }
    if (!matches) continue;
    const haystack = [thread.subject, thread.recipient, ...messages.flatMap(message => [message.subject, message.body, message.from]),
      ...drafts.flatMap(draft => [draft.subject, draft.body])].join('\n').toLowerCase();
    if (query && !haystack.includes(query)) continue;
    const preview = (messages.at(-1)?.body ?? drafts.at(-1)?.body ?? '').replace(/\s+/g, ' ').slice(0, 160);
    threads.push({ ...structuredClone(thread), messageCount: messages.length, draftCount: drafts.length,
      pendingCount: state.intents.filter(intent => intent.threadId === thread.id
        && ['queued', 'prepared', 'handed-off', 'uncertain'].includes(intent.status)).length, preview });
  }
  threads.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id));
  return { threads: threads.slice(offset, offset + limit), total: threads.length, nextOffset: offset + limit < threads.length ? offset + limit : null };
}

export function projectThread(state: CorrespondenceState, ctx: Context, threadId: string): {
  thread: MailThread; messages: MailMessage[]; drafts: MailDraft[];
} {
  readAccess(state, ctx, true);
  const thread = state.threads.find(item => item.id === threadId);
  invariant(thread, 'not_found', 'Thread was not found');
  return structuredClone({ thread, messages: state.messages.filter(message => message.threadId === threadId),
    drafts: state.drafts.filter(draft => draft.threadId === threadId && draft.status !== 'discarded') });
}

/** A reply remains attributed, unverified evidence. It is never an authorization or policy directive. */
export function projectReplyEvidence(state: CorrespondenceState, ctx: Context, messageId: string): ReplyEvidence {
  readAccess(state, ctx, false);
  const message = state.messages.find(item => item.id === messageId);
  invariant(message?.direction === 'inbound' && message.evidence, 'not_found', 'Inbound evidence was not found');
  return { ref: { tenantId: state.tenantId, projectId: state.projectId, kind: message.kind, id: message.id, revision: message.revision },
    verification: 'unverified', policyAuthority: false, attributedSender: message.evidence.attributedSender,
    subject: message.subject, body: message.body, receivedAt: message.at,
    provider: message.evidence.provider, providerMessageId: message.evidence.providerMessageId };
}
