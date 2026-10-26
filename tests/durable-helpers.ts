import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '@accountability/evidence/database';
import type { Context } from '../src/contracts.ts';
import { CorrespondenceRepository } from '../src/durable.ts';
import type { CorrespondenceCommand, CorrespondenceState, GatewaySendCommand, SyncBinding } from '../src/index.ts';

export const migrationUrl = new URL('../migrations/001_foundation.sql', import.meta.resolve('@accountability/evidence/database'));
export const human: Context = { tenantId: 'tenant-fixture', projectId: 'project-fixture', purpose: 'research-outreach',
  requestId: 'durable-request', now: '2030-01-01T00:00:00.000Z', actor: { id: 'editor', kind: 'human', roles: [
    'correspondence:read', 'correspondence:write', 'correspondence:control', 'correspondence:authorize'] } };
export const gateway: Context = { ...human, actor: { id: 'gateway', kind: 'service', roles: ['correspondence:gateway', 'correspondence:ingress'] } };
export const agent: Context = { ...human, actor: { id: 'research-agent', kind: 'agent', roles: ['correspondence:write'] } };
export const code = (expected: string) => (err: unknown) => err !== null && typeof err === 'object' && 'code' in err && err.code === expected;
export function database(pg: PGlite, fault: { afterRecord?: boolean; beforeCommit?: boolean; afterCommit?: boolean } = {}): Database {
  return { async transaction(fn) {
    const result = await pg.transaction(async tx => {
      const value = await fn({ query: async <T>(sql: string, values?: unknown[]) => {
        const result = await tx.query(sql, values);
        if (fault.afterRecord && sql.startsWith('INSERT INTO public.evidence_record')) throw new Error('simulated failure after real record insert');
        return { rows: result.rows as T[] };
      } });
      if (fault.beforeCommit) throw new Error('simulated failure before commit');
      return value;
    });
    if (fault.afterCommit) throw new Error('simulated lost commit acknowledgement');
    return result;
  }, close: () => pg.close() };
}
export async function setup(t: { after(fn: () => Promise<void>): void }, options: { persistent?: boolean; restricted?: boolean } = {}) {
  const path = options.persistent ? await mkdtemp(join(process.cwd(), '.database-test-')) : undefined;
  let pg = new PGlite(path);
  t.after(async () => { await pg.close(); if (path) await rm(path, { recursive: true, force: true }); });
  await pg.exec(await readFile(migrationUrl, 'utf8'));
  await pg.exec('CREATE ROLE correspondence_test_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO correspondence_test_login;');
  if (options.restricted !== false) await pg.exec('SET SESSION AUTHORIZATION correspondence_test_login');
  const fault: { afterRecord?: boolean; beforeCommit?: boolean; afterCommit?: boolean } = {};
  let db = database(pg, fault); let repo = new CorrespondenceRepository(db);
  return { get pg() { return pg; }, get db() { return db; }, get repo() { return repo; }, fault,
    async restart() { if (!path) throw new Error('Persistent fixture required'); await pg.close(); pg = new PGlite(path);
      await pg.exec('SET SESSION AUTHORIZATION correspondence_test_login'); db = database(pg, fault); repo = new CorrespondenceRepository(db); },
  };
}
export async function initialize(repo: CorrespondenceRepository) { return repo.initialize(human, { mailboxId: 'mailbox', brand: 'Example Research' }); }
export async function connect(repo: CorrespondenceRepository, provider: 'fake' | 'gmail' = 'gmail'): Promise<CorrespondenceState> {
  return (await repo.execute(human, 'mailbox', 0, { type: 'connectMailbox', inputId: 'connect', connection: {
    provider, accountRef: 'account', connectionRef: 'external-handle', address: 'research@alpha.example' } })).state;
}
export function binding(state: CorrespondenceState): SyncBinding {
  return { tenantId: state.tenantId, projectId: state.projectId, mailboxId: state.mailbox.id, provider: 'gmail',
    accountRef: 'account', address: 'research@alpha.example', providerAccountId: 'research@alpha.example',
    folderId: null, authEpoch: state.mailbox.epochs.auth };
}
export async function prepared(repo: CorrespondenceRepository, end: 'prepared' | 'handed-off' = 'prepared') {
  await initialize(repo); let state = await connect(repo, 'fake');
  async function step(ctx: Context, command: CorrespondenceCommand) { const result = await repo.execute(ctx, 'mailbox', state.revision, command); state = result.state; return result; }
  await step(human, { type: 'setControl', inputId: 'autonomy', mode: 'autonomous' });
  await step(human, { type: 'issueGrant', inputId: 'grant', grant: { id: 'grant', mode: 'autonomous', actorIds: [agent.actor.id],
    recipients: ['records@beta.example'], purpose: agent.purpose, notBefore: agent.now, expiresAt: '2030-01-02T00:00:00Z',
    maxSends: 1, maxFollowups: 0, cooldownMs: 86_400_000 } });
  await step(agent, { type: 'createThread', inputId: 'thread', threadId: 'thread', recipient: 'records@beta.example', subject: 'Records' });
  await step(agent, { type: 'createDraft', inputId: 'draft', draftId: 'draft', threadId: 'thread', content: { kind: 'research', topic: 'Records', questions: ['Where are the records?'] } });
  await step(agent, { type: 'queueDraft', inputId: 'queue', draftId: 'draft', expectedVersion: 1, intentId: 'intent', grantId: 'grant' });
  const prepare = await step(gateway, { type: 'prepareDispatch', inputId: 'prepare', intentId: 'intent' });
  const handoff: CorrespondenceCommand = { type: 'handoff', inputId: 'handoff', intentId: 'intent', ticketId: prepare.result.ticketId! };
  let send: GatewaySendCommand | null = null;
  if (end === 'handed-off') send = (await step(gateway, handoff)).gatewayCommands[0] as GatewaySendCommand;
  return { state, handoff, send };
}
