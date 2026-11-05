import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredResponse } from '../../../server/src/api/idempotency.ts';
import { asService, asUser } from './db.ts';
import { PgIdempotencyStore } from './idempotency.ts';
import { PgProjectRepo } from './project-repo.ts';
import { connect, createUser, haveSupabase, removeUser, sampleProject, type TestUser } from './supabase-test-env.ts';
import { PgUsageLog } from './usage-log.ts';

const { pool, db } = haveSupabase ? connect() : ({} as ReturnType<typeof connect>);

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  if (!haveSupabase) return;
  [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
});

afterAll(async () => {
  if (!haveSupabase) return;
  await Promise.all([removeUser(alice), removeUser(bob)]);
  await pool.end();
});

const response = (text: string, status = 200): StoredResponse => ({
  status,
  headers: [['content-type', 'application/json']],
  body: new TextEncoder().encode(text),
});

describe.skipIf(!haveSupabase)('PgUsageLog', () => {
  it('totals the month to date (UTC) and the editor calls per project', async () => {
    const usage = new PgUsageLog(db);
    const project = await asUser(alice.id, async () => {
      const repo = new PgProjectRepo(db);
      const id = await repo.newId('usage');
      await repo.create(sampleProject(id));
      return id;
    });
    await asUser(alice.id, async () => {
      await usage.record({ userId: alice.id, projectId: project, call: 'regenerate', model: 'gpt-6-luna', costUsd: 0.0012345678 });
      await usage.record({ userId: alice.id, projectId: project, call: 'regenerate', costUsd: 0.001 });
      await usage.record({ userId: alice.id, projectId: project, call: 'regions', costUsd: 0.0005 });
      await usage.record({ userId: alice.id, projectId: project, call: 'analysis.annotate', costUsd: 0.5, at: '2026-10-31T23:59:59.000Z' });
      await usage.record({ userId: alice.id, projectId: project, call: 'render', costUsd: 0, containerSec: 104.5 });
    });
    // A Workflow (no user) records for the job's owner.
    await asService(() => usage.record({ userId: alice.id, projectId: project, call: 'analysis.evaluate', costUsd: 0.25 }));

    const now = new Date();
    const total = await asUser(alice.id, () => usage.monthToDate(alice.id, now));
    // The October call doesn't count this month; costs are kept to 6 decimals.
    expect(total).toBe(0.252735);
    // Asked in October, it counts everything since October 1 (as on Node).
    expect(await asUser(alice.id, () => usage.monthToDate(alice.id, new Date('2026-10-15T00:00:00Z')))).toBe(0.752735);

    const totals = await asUser(alice.id, () => usage.projectTotals(project));
    expect(totals.regenerate).toEqual({ count: 2, costUsd: 0.002235 });
    expect(totals.regions).toEqual({ count: 1, costUsd: 0.0005 });
    expect(totals.evaluate).toEqual({ count: 0, costUsd: 0 });

    // Deleting the project keeps what it cost: the month's total can't be reset that way.
    await asUser(alice.id, () => new PgProjectRepo(db).remove(project));
    expect(await asUser(alice.id, () => usage.monthToDate(alice.id, now))).toBe(total);
  });
});

describe.skipIf(!haveSupabase)('PgIdempotencyStore', () => {
  const store = haveSupabase ? new PgIdempotencyStore(db, { pollMs: 20 }) : (undefined as unknown as PgIdempotencyStore);

  it('replays a kept response, refuses another body, and frees a key whose response was not kept', async () => {
    const first = await store.claim(alice.id, 'key-00000001', 'hash-a');
    expect(first.kind).toBe('new');
    if (first.kind !== 'new') return;
    await first.finish(response('{"ok":1}', 201));

    const again = await store.claim(alice.id, 'key-00000001', 'hash-a');
    expect(again.kind).toBe('replay');
    if (again.kind === 'replay') {
      expect(again.response.status).toBe(201);
      expect(again.response.headers).toEqual([['content-type', 'application/json']]);
      expect(new TextDecoder().decode(again.response.body)).toBe('{"ok":1}');
    }
    expect((await store.claim(alice.id, 'key-00000001', 'hash-b')).kind).toBe('mismatch');

    // Keys are per user: Bob's same key is his own.
    expect((await store.claim(bob.id, 'key-00000001', 'hash-b')).kind).toBe('new');

    // A 5xx is not kept, so a retry runs again.
    const failing = await store.claim(alice.id, 'key-00000002', 'hash-a');
    if (failing.kind === 'new') await failing.finish(undefined);
    expect((await store.claim(alice.id, 'key-00000002', 'hash-a')).kind).toBe('new');
  });

  it('makes a repeat wait for the first call and replay its response', async () => {
    const first = await store.claim(alice.id, 'key-00000003', 'hash-a');
    if (first.kind !== 'new') throw new Error('expected a new claim');
    const repeat = store.claim(alice.id, 'key-00000003', 'hash-a');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.finish(response('{"done":true}'));
    const answered = await repeat;
    expect(answered.kind).toBe('replay');
  });

  it('takes over a claim left running past the stale limit (its Worker died)', async () => {
    const quick = new PgIdempotencyStore(db, { pollMs: 20, staleMs: 200 });
    expect((await quick.claim(alice.id, 'key-00000004', 'hash-a')).kind).toBe('new');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await quick.claim(alice.id, 'key-00000004', 'hash-a')).kind).toBe('new');
  });
});
