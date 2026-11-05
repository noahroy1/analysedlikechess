import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Job } from '@als/schema';
import { NotFoundError } from '../ports.ts';
import { TokenVerifier } from '../auth.ts';
import { RealtimeEventBus, userTopic } from '../realtime.ts';
import { asService, asUser, type Sql } from './db.ts';
import { PgIdempotencyStore } from './idempotency.ts';
import { PgProjectRepo } from './project-repo.ts';
import { connect, createUser, env, haveSupabase, removeUser, sampleProject, type TestUser } from './supabase-test-env.ts';
import { PgUsageLog } from './usage-log.ts';

// C3's isolation check (PLAN-CLOUD.md): a second user sees none of the first
// user's projects, files' rows, jobs, spend or broadcasts, through the repos and
// directly against RLS. The API half (routes, media URLs) follows when the
// Worker serves the routes.

const { pool, db } = haveSupabase ? connect() : ({} as ReturnType<typeof connect>);
const repo = haveSupabase ? new PgProjectRepo(db) : (undefined as unknown as PgProjectRepo);

let alice: TestUser;
let bob: TestUser;
let project: string;

const TABLES = ['project_ids', 'projects', 'project_versions', 'stage_cache', 'uploads', 'jobs', 'renders', 'usage', 'idempotency_keys', 'profiles'];

const job = (projectId: string): Job => ({
  id: `job-${crypto.randomUUID().slice(0, 8)}`,
  projectId,
  kind: 'analysis',
  state: { status: 'running', stages: [{ name: 'annotate', status: 'running', progress: 0.5 }], models: {} },
});

beforeAll(async () => {
  if (!haveSupabase) return;
  [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
  // Alice has a project with history, stages, a render, an upload, a job, spend and a key.
  project = await asUser(alice.id, async () => {
    const id = await repo.newId('alice private');
    await repo.create(sampleProject(id));
    await repo.save(id, 1, () => undefined);
    await repo.putStage(id, 'analysis', 'annotate', 'k', { secret: true });
    await repo.putUpload({
      projectId: id,
      uploadId: 'u',
      file: 'source.mp4',
      originalName: 'a.mp4',
      size: 1,
      partSize: 1,
      partCount: 1,
      context: {},
      createdAt: new Date().toISOString(),
    });
    await repo.editRenders(id, (jobs) => {
      jobs.push({
        id: 'v2-20261105-120000',
        projectVersion: 2,
        preset: 'source',
        width: 1280,
        height: 720,
        fps: 30,
        frames: 300,
        status: 'done',
        progress: 1,
        createdAt: new Date().toISOString(),
        file: 'renders/v2-20261105-120000.mp4',
      });
    });
    await new PgUsageLog(db).record({ userId: alice.id, projectId: id, call: 'regenerate', costUsd: 0.01 });
    await new PgIdempotencyStore(db).claim(alice.id, 'alice-key-1', 'h');
    return id;
  });
  // Jobs are written by the API (C3: Workflows), as the service.
  await asService(() =>
    db.tx((sql) =>
      sql.query(`insert into app.jobs (id, project_id, owner_id, kind, status, state) values ($1, $2, $3, 'analysis', 'running', '{}')`, [
        `job-${crypto.randomUUID().slice(0, 8)}`,
        project,
        alice.id,
      ]),
    ),
  );
});

afterAll(async () => {
  if (!haveSupabase) return;
  await Promise.all([removeUser(alice), removeUser(bob)]);
  await pool.end();
});

/** Which of Alice's rows each table holds ($1 her id, $2 her project). */
const MINE: Record<string, string> = {
  project_ids: 'id = $2 or owner_id = $1',
  projects: 'id = $2',
  project_versions: 'project_id = $2',
  stage_cache: 'project_id = $2',
  uploads: 'project_id = $2',
  renders: 'project_id = $2',
  jobs: 'project_id = $2 or owner_id = $1',
  usage: 'user_id = $1 or project_id = $2',
  idempotency_keys: 'user_id = $1',
  profiles: 'user_id = $1',
};

/** How many of Alice's rows a query in this user's transaction can see, per table. */
async function visibleTo(user: TestUser): Promise<Record<string, number>> {
  return asUser(user.id, () =>
    db.tx(async (sql: Sql) => {
      const counts: Record<string, number> = {};
      for (const table of TABLES) {
        const { rows } = await sql.query<{ n: number }>(
          `select count(*)::int as n from app.${table} where (${MINE[table]}) and $1::uuid is not null and $2::text is not null`,
          [alice.id, project],
        );
        counts[table] = rows[0]!.n;
      }
      return counts;
    }),
  );
}

describe.skipIf(!haveSupabase)('a second user', () => {
  it('sees all of Alice’s rows as Alice (the control)', async () => {
    const counts = await visibleTo(alice);
    for (const table of TABLES) expect(counts[table], table).toBeGreaterThan(0);
  });

  it('sees none of them directly through RLS', async () => {
    const counts = await visibleTo(bob);
    for (const table of TABLES) expect(counts[table], table).toBe(0);
  });

  it('can’t read, change, list or delete her project through the repo', () =>
    asUser(bob.id, async () => {
      expect((await repo.list()).map((p) => p.id)).not.toContain(project);
      await expect(repo.read(project)).rejects.toBeInstanceOf(NotFoundError);
      await expect(repo.save(project, 2, () => undefined)).rejects.toBeInstanceOf(NotFoundError);
      await expect(repo.update(project, () => undefined)).rejects.toBeInstanceOf(NotFoundError);
      await expect(repo.history(project)).rejects.toBeInstanceOf(NotFoundError);
      await expect(repo.readVersion(project, 1)).rejects.toBeInstanceOf(NotFoundError);
      expect(await repo.getStage(project, 'analysis', 'annotate')).toBeUndefined();
      expect(await repo.getUpload(project)).toBeUndefined();
      await expect(repo.renders(project)).rejects.toBeInstanceOf(NotFoundError);
      await expect(repo.editRenders(project, (jobs) => void jobs.splice(0))).rejects.toBeInstanceOf(NotFoundError);
      // Taking over her id by creating a project under it is refused as if it didn't exist.
      await expect(repo.create(sampleProject(project))).rejects.toBeInstanceOf(NotFoundError);
      // Writes that RLS filters out change nothing.
      await repo.putStage(project, 'analysis', 'annotate', 'bob', { overwritten: true }).catch(() => undefined);
      await repo.removeUpload(project);
      await repo.remove(project);
    }).then(async () => {
      // Still all there for Alice.
      await asUser(alice.id, async () => {
        expect((await repo.read(project)).version).toBe(2);
        expect(await repo.getStage(project, 'analysis', 'annotate')).toEqual({ key: 'k', output: { secret: true } });
        expect(await repo.getUpload(project)).toBeDefined();
        expect((await repo.renders(project)).length).toBe(1);
      });
    }));

  it('can’t see her spend, record spend as her, or raise his own cap', async () => {
    const usage = new PgUsageLog(db);
    expect(await asUser(bob.id, () => usage.monthToDate(alice.id))).toBe(0);
    expect((await asUser(bob.id, () => usage.projectTotals(project))).regenerate.count).toBe(0);
    await expect(asUser(bob.id, () => usage.record({ userId: alice.id, projectId: project, call: 'regenerate', costUsd: 1 }))).rejects.toThrow(
      /row-level security/,
    );
    // Users have no update or delete grant on these tables at all.
    await expect(
      asUser(bob.id, () => db.tx((sql) => sql.query('update app.profiles set monthly_cap_usd = 1000, role = $2 where user_id = $1', [bob.id, 'admin']))),
    ).rejects.toThrow('permission denied');
    await expect(asUser(bob.id, () => db.tx((sql) => sql.query('delete from app.usage where user_id = $1', [bob.id])))).rejects.toThrow('permission denied');
  });

  it('can’t reach the tables through the Data API at all', async () => {
    const res = await fetch(`${env.url}/rest/v1/projects?select=id`, {
      headers: { apikey: env.publishableKey!, Authorization: `Bearer ${bob.token}`, 'Accept-Profile': 'app' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('holds a real access token the Worker accepts, for his own id only', async () => {
    const verifier = new TokenVerifier({ supabaseUrl: env.url! });
    expect((await verifier.verify(bob.token)).userId).toBe(bob.id);
    expect((await verifier.verify(alice.token)).userId).toBe(alice.id);
    // The project's own keys are not user tokens.
    await expect(verifier.verify(env.publishableKey!)).rejects.toThrow();
  });
});

// Realtime: the raw protocol (vsn 1.0.0, JSON objects), as supabase-js speaks it.

interface Socket {
  joined: Promise<{ status: string; response: unknown }>;
  received: Job[];
  close(): void;
}

function subscribe(topic: string, token: string, isPrivate: boolean): Socket {
  const ws = new WebSocket(`${env.url!.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${env.publishableKey}&vsn=1.0.0`);
  const received: Job[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const joined = new Promise<{ status: string; response: unknown }>((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          topic: `realtime:${topic}`,
          event: 'phx_join',
          payload: { config: { broadcast: { ack: false, self: false }, presence: { enabled: false }, private: isPrivate }, access_token: token },
          ref: '1',
          join_ref: '1',
        }),
      );
      heartbeat = setInterval(() => ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'hb' })), 20_000);
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { event: string; ref?: string; payload: { status?: string; response?: unknown; event?: string; payload?: Job } };
      if (message.event === 'phx_reply' && message.ref === '1') resolve({ status: message.payload.status ?? '', response: message.payload.response });
      if (message.event === 'broadcast' && message.payload.event === 'job' && message.payload.payload) received.push(message.payload.payload);
    });
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });
  return {
    joined,
    received,
    close: () => {
      clearInterval(heartbeat);
      ws.close();
    },
  };
}

describe.skipIf(!haveSupabase)('live job updates', () => {
  it('reach Alice on her private channel, and neither Bob nor a public channel of the same name', async () => {
    const mine = subscribe(userTopic(alice.id), alice.token, true);
    const snooping = subscribe(userTopic(alice.id), bob.token, true);
    const publicTwin = subscribe(userTopic(alice.id), bob.token, false);
    try {
      expect((await mine.joined).status).toBe('ok');
      const refused = await snooping.joined;
      expect(refused.status).toBe('error');
      expect(JSON.stringify(refused.response)).toMatch(/unauthori[sz]ed|permission|denied/i);
      await publicTwin.joined;

      const bus = new RealtimeEventBus({ supabaseUrl: env.url!, secretKey: env.secretKey! });
      const update = job(project);
      // A just-joined channel can miss the first message for a moment; send until it arrives.
      for (let i = 0; i < 20 && mine.received.length === 0; i++) {
        await bus.send(alice.id, update);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(mine.received[0]).toEqual(update);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(snooping.received).toEqual([]);
      expect(publicTwin.received).toEqual([]);
    } finally {
      mine.close();
      snooping.close();
      publicTwin.close();
    }
  }, 30_000);
});
