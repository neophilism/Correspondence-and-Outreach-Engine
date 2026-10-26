import { scoped } from '@accountability/evidence/database';
import type { Database, UnitOfWork } from '@accountability/evidence/database';
import type { Context } from './contracts.ts';
import { invariant, requireScope, digest } from './contracts.ts';
import { createCorrespondenceState, transitionCorrespondence } from './machine.ts';
import type { CorrespondenceState, CorrespondenceCommand, CorrespondenceTransition } from './types.ts';

/** Evidence's generic persistence SDK is reused against a DEDICATED correspondence database. */
const MAILBOX_KIND = 'correspondence-mailbox-v1';
const mailboxKey = (mailboxId: string) => digest({ mailboxId });

export class CorrespondenceRepository {
  readonly #database: Database;
  constructor(database: Database) { this.#database = database; }

  async initialize(ctx: Context, input: Parameters<typeof createCorrespondenceState>[1]): Promise<CorrespondenceState> {
    const state = createCorrespondenceState(ctx, input);
    return scoped(this.#database, ctx, async (tx: UnitOfWork) => {
      await tx.put(MAILBOX_KIND, mailboxKey(state.mailbox.id), 0, state);
      return state;
    });
  }

  async load(ctx: Context, mailboxId: string): Promise<CorrespondenceState> {
    return scoped(this.#database, ctx, async tx => {
      const row = await tx.get<CorrespondenceState>(MAILBOX_KIND, mailboxKey(mailboxId));
      invariant(row, 'not_found', 'Mailbox was not found'); requireScope(ctx, row.value);
      return row.value;
    });
  }

  /** Commands are released to callers only after scoped() has durably committed. No provider is invoked. */
  async execute(ctx: Context, mailboxId: string, expectedDomainRevision: number, command: CorrespondenceCommand): Promise<CorrespondenceTransition> {
    return scoped(this.#database, ctx, async tx => {
      const row = await tx.get<CorrespondenceState>(MAILBOX_KIND, mailboxKey(mailboxId));
      invariant(row, 'not_found', 'Mailbox was not found');
      invariant(row.value.revision === expectedDomainRevision, 'revision_conflict', 'Mailbox domain revision changed');
      const transition = transitionCorrespondence(row.value, ctx, command);
      if (!transition.duplicate) await tx.put(MAILBOX_KIND, mailboxKey(mailboxId), row.revision, transition.state);
      return transition;
    });
  }
}
