import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderJob, UploadRecord } from '@als/schema';
import { NotFoundError, VersionConflictError } from '../ports.ts';
import { asService, asUser } from './db.ts';
import { HISTORY_LIMIT, PgProjectRepo } from './project-repo.ts';
import { connect, createUser, haveSupabase, removeUser, sampleProject, type TestUser } from './supabase-test-env.ts';

const { pool, db } = haveSupabase ? connect() : ({} as ReturnType<typeof connect>);
const repo = haveSupabase ? new PgProjectRepo(db) : (undefined as unknown as PgProjectRepo);

let alice: TestUser;

beforeAll(async () => {
  if (!haveSupabase) return;
  alice = await createUser('alice');
});

afterAll(async () => {
  if (!haveSupabase) return;
  await removeUser(alice);
  await pool.end();
});

const render = (id: string, status: RenderJob['status'] = 'done'): RenderJob => ({
  id,
  projectVersion: 1,
  preset: 'source',
  width: 1280,
  height: 720,
  fps: 30,
  frames: 300,
  status,
  progress: status === 'done' ? 1 : 0,
  createdAt: new Date().toISOString(),
  file: `renders/${id}.mp4`,
});

describe.skipIf(!haveSupabase)('PgProjectRepo', () => {
  it('needs a scope: a call that lost its user runs nothing', async () => {
    await expect(repo.list()).rejects.toThrow('outside a user or service scope');
  });

  it('reserves ids, creates, reads, lists and saves with version checks', () =>
    asUser(alice.id, async () => {
      const id = await repo.newId('My Clip (final).mov');
      expect(id).toMatch(/^my-clip-final-[0-9a-f]{4}$/);
      // Reserved but no document yet: not listed (an upload in progress).
      expect((await repo.list()).map((p) => p.id)).not.toContain(id);
      await expect(repo.read(id)).rejects.toBeInstanceOf(NotFoundError);

      await repo.create(sampleProject(id));
      expect((await repo.read(id)).version).toBe(1);
      expect((await repo.list()).map((p) => p.id)).toContain(id);

      const saved = await repo.save(id, 1, (p) => {
        p.moments[0]!.moveLabel = 'Edited';
      });
      expect(saved.version).toBe(2);
      expect((await repo.read(id)).moments[0]!.moveLabel).toBe('Edited');
      const conflict = await repo.save(id, 1, () => undefined).catch((e: unknown) => e);
      expect(conflict).toBeInstanceOf(VersionConflictError);
      expect((conflict as VersionConflictError).current).toBe(2);

      // History holds the version each save replaced.
      const history = await repo.history(id);
      expect(history.map((h) => h.version)).toEqual([1]);
      expect(history[0]!.momentCount).toBe(3);
      expect((await repo.readVersion(id, 1)).moments[0]!.moveLabel).not.toBe('Edited');
      await expect(repo.readVersion(id, 2)).rejects.toBeInstanceOf(NotFoundError);

      // update() without a snapshot moves the version but adds no history.
      expect((await repo.update(id, (p) => ({ ...p, title: 'Renamed' }))).version).toBe(3);
      expect((await repo.history(id)).length).toBe(1);
      expect((await repo.update(id, () => undefined, { snapshot: true })).version).toBe(4);
      expect((await repo.history(id)).map((h) => h.version)).toEqual([3, 1]);
      await repo.remove(id);
    }));

  it('keeps the newest 20 versions', () =>
    asUser(alice.id, async () => {
      const id = await repo.newId('history');
      await repo.create(sampleProject(id));
      for (let v = 1; v <= HISTORY_LIMIT + 5; v++) await repo.save(id, v, () => undefined);
      const versions = (await repo.history(id)).map((h) => h.version);
      expect(versions.length).toBe(HISTORY_LIMIT);
      expect(versions[0]).toBe(HISTORY_LIMIT + 5);
      expect(versions.at(-1)).toBe(6);
      await repo.remove(id);
    }));

  it('applies concurrent saves one at a time: one wins, the other is a version conflict', () =>
    asUser(alice.id, async () => {
      const id = await repo.newId('race');
      await repo.create(sampleProject(id));
      const results = await Promise.allSettled([repo.save(id, 1, () => undefined), repo.save(id, 1, () => undefined)]);
      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(VersionConflictError);
      // Concurrent update()s don't lose each other's changes.
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          repo.update(id, (p) => {
            p.moments[0]!.moveLabel = `${p.moments[0]!.moveLabel}+${i}`;
          }),
        ),
      );
      expect((await repo.read(id)).version).toBe(7);
      expect((await repo.read(id)).moments[0]!.moveLabel.split('+').length).toBe(6);
      await repo.remove(id);
    }));

  it('caches stages, keeps the render list in order, and holds the upload record', () =>
    asUser(alice.id, async () => {
      const id = await repo.newId('stages');
      const upload: UploadRecord = {
        projectId: id,
        uploadId: 'u1',
        file: 'source.mp4',
        originalName: 'stages.mp4',
        size: 10,
        partSize: 8 * 1024 * 1024,
        partCount: 1,
        context: {},
        createdAt: new Date().toISOString(),
      };
      // The upload exists before the project document does.
      await repo.putUpload(upload);
      expect(await repo.getUpload(id)).toEqual(upload);
      await repo.create(sampleProject(id));
      await repo.removeUpload(id);
      expect(await repo.getUpload(id)).toBeUndefined();

      expect(await repo.getStage(id, 'analysis', 'annotate')).toBeUndefined();
      await repo.putStage(id, 'analysis', 'annotate', 'k1', { moves: [1] });
      await repo.putStage(id, 'analysis', 'annotate', 'k2', { moves: [2] });
      await repo.putStage(id, 'ingest', 'proxy', 'p1', null);
      expect(await repo.getStage(id, 'analysis', 'annotate')).toEqual({ key: 'k2', output: { moves: [2] } });
      expect(await repo.getStage(id, 'ingest', 'proxy')).toEqual({ key: 'p1', output: null });

      expect(await repo.renders(id)).toEqual([]);
      await repo.editRenders(id, (jobs) => {
        jobs.push(render('v1-20261105-100000', 'running'), render('v1-20261105-090000'));
      });
      await repo.editRenders(id, (jobs) => {
        jobs[0]!.status = 'done';
        jobs.push(render('v1-20261105-110000'));
      });
      expect((await repo.renders(id)).map((j) => [j.id, j.status])).toEqual([
        ['v1-20261105-100000', 'done'],
        ['v1-20261105-090000', 'done'],
        ['v1-20261105-110000', 'done'],
      ]);
      await repo.editRenders(id, (jobs) => {
        jobs.splice(1, 1);
      });
      expect((await repo.renders(id)).map((j) => j.id)).toEqual(['v1-20261105-100000', 'v1-20261105-110000']);
      await expect(repo.renders('no-such-project')).rejects.toBeInstanceOf(NotFoundError);

      // Removing the project takes every row with it.
      await repo.remove(id);
      await expect(repo.read(id)).rejects.toBeInstanceOf(NotFoundError);
      const left = await asService(() =>
        db.tx((sql) =>
          sql.query<{ n: number }>(
            `select (select count(*) from app.stage_cache where project_id = $1)
                  + (select count(*) from app.renders where project_id = $1)
                  + (select count(*) from app.project_versions where project_id = $1)::int as n`,
            [id],
          ),
        ),
      );
      expect(Number(left.rows[0]!.n)).toBe(0);
    }));
});
