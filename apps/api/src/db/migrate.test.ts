import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderJob } from '@als/schema';
import { HINTS_STAGE, NotFoundError, projectKey } from '../ports.ts';
import { FsBlobStore } from '../node/fs-blobs.ts';
import { FsProjectRepo } from '../node/fs-repo.ts';
import { migrateProject } from '../node/migrate.ts';
import { asUser } from './db.ts';
import { PgProjectRepo } from './project-repo.ts';
import { connect, createUser, haveSupabase, removeUser, sampleProject, type TestUser } from './supabase-test-env.ts';

// C4's migration, against local Supabase: a project folder the way the Node
// server left it goes into Postgres (and a BlobStore) under one owner, whole.

const { pool, db } = haveSupabase ? connect() : ({} as ReturnType<typeof connect>);
const repo = haveSupabase ? new PgProjectRepo(db) : (undefined as unknown as PgProjectRepo);

let alice: TestUser;
let bob: TestUser;
let dirs: string[] = [];

beforeAll(async () => {
  if (!haveSupabase) return;
  alice = await createUser('alice');
  bob = await createUser('bob');
});

afterAll(async () => {
  if (!haveSupabase) return;
  await removeUser(alice);
  await removeUser(bob);
  await pool.end();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(!haveSupabase)('migrateProject', () => {
  it('copies the document, history, stage caches, renders and media; a repeat skips the media', async () => {
    const from = await mkdtemp(join(tmpdir(), 'als-migrate-from-'));
    const to = await mkdtemp(join(tmpdir(), 'als-migrate-to-'));
    dirs = [from, to];
    const id = `mig-${crypto.randomUUID().slice(0, 8)}`;

    // A folder as the Node server wrote it: two saves (so two versions in history), every kind of stage, a render, media.
    const source = new FsProjectRepo(from);
    await source.create(sampleProject(id));
    await source.save(id, 1, (p) => void (p.title = 'Second'));
    await source.save(id, 2, (p) => void (p.title = 'Third'));
    await source.putStage(id, 'ingest', 'hash', 'k-hash', { sourceHash: 'abc' });
    await source.putStage(id, 'ingest', 'proxy', 'k-proxy', null);
    await source.putStage(id, 'analysis', 'transcribe', 'k-tr', { words: [1, 2] });
    await source.putStage(id, 'analysis', HINTS_STAGE, '', ['Red', 'Blue']);
    await source.putStage(id, 'regions', 'frame-12', 'frame-12', { faces: [] });
    const job: RenderJob = {
      id: 'v3-20261106-101500', projectVersion: 3, preset: 'source', width: 1280, height: 720, fps: 30, frames: 300,
      status: 'done', progress: 1, createdAt: new Date().toISOString(), file: 'renders/v3-20261106-101500.mp4',
    };
    await source.editRenders(id, (jobs) => void jobs.push(job));
    await writeFile(join(from, id, 'proxy.mp4'), new Uint8Array([1, 2, 3, 4]));
    await writeFile(join(from, id, 'renders/v3-20261106-101500.mp4'), new Uint8Array([5, 6]));
    await writeFile(join(from, id, '.DS_Store'), 'x');

    const blobs = new FsBlobStore({ projectsDir: to, soundsDir: to });
    // Parts of one byte: the 4-byte proxy goes up as a multipart upload, the 2-byte render in one write.
    const target = { db, repo, blobs, partBytes: 1 };
    const report = await asUser(alice.id, () => migrateProject(source, id, target));
    expect(report).toMatchObject({ versions: 2, stages: 5, renders: 1, files: 2, skippedFiles: 0 });

    await asUser(alice.id, async () => {
      const project = await repo.read(id);
      expect(project).toEqual(await source.read(id));
      expect((await repo.history(id)).map((h) => h.version)).toEqual([2, 1]);
      expect((await repo.readVersion(id, 2)).title).toBe('Second');
      expect(await repo.getStage(id, 'ingest', 'hash')).toEqual({ key: 'k-hash', output: { sourceHash: 'abc' } });
      expect(await repo.getStage(id, 'analysis', 'transcribe')).toEqual({ key: 'k-tr', output: { words: [1, 2] } });
      expect((await repo.getStage(id, 'analysis', HINTS_STAGE))?.output).toEqual(['Red', 'Blue']);
      expect((await repo.getStage(id, 'regions', 'frame-12'))?.output).toEqual({ faces: [] });
      expect(await repo.renders(id)).toEqual([job]);
    });
    expect((await blobs.head(projectKey(id, 'proxy.mp4')))?.size).toBe(4);
    expect([...new Uint8Array(await (await blobs.blob(projectKey(id, 'proxy.mp4')))!.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(await (await blobs.blob(projectKey(id, 'renders/v3-20261106-101500.mp4')))!.arrayBuffer())]).toEqual([5, 6]);
    expect(await blobs.head(projectKey(id, 'analysis/transcribe.json'))).toBeUndefined();
    expect(await blobs.head(projectKey(id, 'project.json'))).toBeUndefined();

    const again = await asUser(alice.id, () => migrateProject(source, id, target));
    expect(again).toMatchObject({ files: 0, skippedFiles: 2 });
    await asUser(bob.id, () => expect(repo.read(id)).rejects.toBeInstanceOf(NotFoundError));
  });
});
