import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateProjectResultSchema,
  JobSchema,
  MeSchema,
  ProjectSchema,
  RenderJobSchema,
  UPLOAD_PART_BYTES,
  UploadPartsResultSchema,
  type Project,
} from '@als/schema';
import { ProviderError, type Providers } from './analysis/providers/index.ts';
import { makeProviders } from './node/providers.ts';
import { LOCAL_USER } from './node/server.ts';
import type { MediaRunner } from './ports.ts';
import { DIALOGUE_RECORDING, makeTestApp, uploadFile, type TestApp } from './test-helpers.ts';
import { loadAnalysisConfig } from './analysis/config.ts';

// The v1 contract (PLAN-CLOUD.md, "API contract"): every POST, PUT and DELETE
// repeated with the same Idempotency-Key gets the same response and has one
// effect, job starts return the running job, errors carry stable codes, paid
// calls stop at the cap, and media is only served at signed URLs.

const DIALOGUE = new URL('../../../fixtures/dialogue/source.mp4', import.meta.url);

/** A gate a test opens when it is ready. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

/** Sends the same request twice with one key; returns both responses, parsed. */
async function twice(env: TestApp, path: string, init: { method?: string; json?: unknown } = {}) {
  const key = `same-${Math.random().toString(36).slice(2)}`;
  const first = await env.call(path, { ...init, key });
  const second = await env.call(path, { ...init, key });
  const body = async (res: Response) => (res.status === 204 ? null : res.json());
  return { first, second, a: await body(first), b: await body(second) };
}

describe('the same key, twice: the same response and one effect', { timeout: 30_000 }, () => {
  let root: string;
  let env: TestApp;
  let project: Project;
  const decisionsGate = gate();
  const renderGate = gate();
  let regenerateFailures = 1;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'als-contract-'));
    const replay = makeProviders({ ...loadAnalysisConfig({}), replayDir: DIALOGUE_RECORDING });
    const providers: Providers = {
      ...replay,
      analyst: {
        async run(call) {
          if (call.name === 'decisions') await decisionsGate.opened;
          // A provider outage on the first Regenerate: a 502, which is not kept, so the retry runs.
          if (call.name === 'regenerate' && regenerateFailures-- > 0) throw new ProviderError('overloaded');
          return replay.analyst.run(call);
        },
      },
    };
    const wrapMedia = (media: MediaRunner): MediaRunner =>
      Object.assign(Object.create(media) as MediaRunner, {
        // Renders wait until the test lets them, or are cancelled.
        async render({ signal }: { signal: AbortSignal }) {
          signal.throwIfAborted();
          await Promise.race([renderGate.opened, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))))]);
          return { sizeBytes: 1 };
        },
      });
    env = await makeTestApp(root, {}, undefined, undefined, { providers, wrapMedia });
  });

  afterAll(async () => {
    decisionsGate.open();
    renderGate.open();
    await env.jobs.whenIdle();
    await rm(root, { recursive: true, force: true });
  });

  it('uploads: create, parts and complete each repeat safely', async () => {
    const bytes = new Uint8Array(await readFile(DIALOGUE));
    const create = await twice(env, '/projects', { json: { name: 'dialogue.mp4', size: bytes.byteLength, context: { characters: ['Red'] } } });
    expect(create.first.status).toBe(201);
    expect(create.second.status).toBe(201);
    expect(create.second.headers.get('idempotent-replayed')).toBe('true');
    expect(create.b).toEqual(create.a);
    const { projectId, upload } = CreateProjectResultSchema.parse(create.a);
    // One project folder reserved, not two.
    expect((await readdir(root)).filter((f) => !f.startsWith('.'))).toEqual([projectId]);

    const parts = await twice(env, `/projects/${projectId}/upload/parts`, { json: { uploadId: upload.uploadId } });
    expect(parts.b).toEqual(parts.a);
    const [part] = UploadPartsResultSchema.parse(parts.a).parts;
    const put = () => env.app.request(part!.url, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.byteLength) } });
    const etag = (await put()).headers.get('etag')!;
    expect((await put()).headers.get('etag')).toBe(etag);

    const complete = await twice(env, `/projects/${projectId}/upload/complete`, { json: { uploadId: upload.uploadId, parts: [{ partNumber: 1, etag }] } });
    expect(complete.first.status).toBe(201);
    expect(complete.b).toEqual(complete.a);
    project = ProjectSchema.parse(complete.a);
    // A new key after it completed still returns the project.
    const again = await env.call(`/projects/${projectId}/upload/complete`, { json: { uploadId: upload.uploadId, parts: [{ partNumber: 1, etag }] } });
    expect(again.status).toBe(200);
    expect(ProjectSchema.parse(await again.json()).id).toBe(projectId);
    await env.jobs.whenIdle();
    expect((await (await env.call('/projects')).json()) as unknown[]).toHaveLength(1);
    project = await env.store.read(projectId);
    expect(project.ingest.status).toBe('done');
  }, 60_000);

  it('analyze returns the running job, to a repeat and to a new request alike', async () => {
    const start = await twice(env, `/projects/${project.id}/analyze`, { json: {} });
    expect(start.first.status).toBe(202);
    expect(start.b).toEqual(start.a);
    const job = JobSchema.parse(start.a);
    expect(job).toMatchObject({ kind: 'analysis', projectId: project.id });

    const other = await env.call(`/projects/${project.id}/analyze`, { json: { rerun: 'analyst' } });
    expect(other.status).toBe(200);
    expect(JobSchema.parse(await other.json()).id).toBe(job.id);
    // Clients read the snapshot on connect.
    const live = JobSchema.array().parse(await (await env.call('/jobs')).json());
    expect(live.map((j) => j.id)).toEqual([job.id]);

    decisionsGate.open();
    await env.jobs.whenIdle();
    expect(await (await env.call('/jobs')).json()).toEqual([]);
    project = await env.store.read(project.id);
    expect(project.analysis.status).toBe('done');
    // Transcribed once.
    const log = await readFile(join(root, '.usage', 'usage.jsonl'), 'utf8');
    expect(log.split('\n').filter((l) => l.includes('"analysis.transcribe"'))).toHaveLength(1);
  }, 60_000);

  it('saves once', async () => {
    const edit = { version: project.version, moments: project.moments, characters: project.context.characters, themeId: project.themeId, title: 'Once' };
    const save = await twice(env, `/projects/${project.id}`, { method: 'PUT', json: edit });
    expect(save.a).toEqual({ version: project.version + 1 });
    expect(save.b).toEqual(save.a);
    expect((await env.store.read(project.id)).version).toBe(project.version + 1);

    // Two at once with one key: the second waits for the first and replays it.
    const next = { ...edit, version: project.version + 1, title: 'Twice' };
    const [x, y] = await Promise.all([1, 2].map(() => env.call(`/projects/${project.id}`, { method: 'PUT', json: next, key: 'concurrent-save-key' })));
    expect([x!.status, y!.status]).toEqual([200, 200]);
    expect(await y!.json()).toEqual(await x!.json());
    project = await env.store.read(project.id);
    expect(project.version).toBe(edit.version + 2);
  });

  it('restores once', async () => {
    const restore = await twice(env, `/projects/${project.id}/history/${project.version - 1}/restore`, { json: { version: project.version } });
    expect(restore.first.status).toBe(200);
    expect(restore.b).toEqual(restore.a);
    expect((await env.store.read(project.id)).version).toBe(project.version + 1);
    project = await env.store.read(project.id);
  });

  it('keeps no server error, so a retry after a provider outage runs again', async () => {
    const key = 'regenerate-after-outage';
    const body = { moment: project.moments[0], instruction: 'shorter' };
    const failed = await env.call(`/projects/${project.id}/regenerate`, { json: body, key });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: 'provider_error' });
    const retried = await env.call(`/projects/${project.id}/regenerate`, { json: body, key });
    expect(retried.status).toBe(200);
    const replayed = await env.call(`/projects/${project.id}/regenerate`, { json: body, key });
    expect(await replayed.json()).toEqual(await retried.json());
    expect((await env.usage.projectTotals(project.id)).regenerate.count).toBe(1);
  });

  it('evaluates and finds regions once', async () => {
    const moments = project.moments.map(({ eval: _, ...m }) => m);
    const evaluate = await twice(env, `/projects/${project.id}/evaluate`, { json: { moments, characters: project.context.characters } });
    expect(evaluate.first.status).toBe(200);
    expect(evaluate.b).toEqual(evaluate.a);
    const moment = { ...project.moments[0]!, sourceTime: project.moments[0]!.sourceTime + 0.4 };
    const regions = await twice(env, `/projects/${project.id}/regions`, { json: { moment } });
    expect(regions.first.status).toBe(200);
    expect(regions.b).toEqual(regions.a);
    const totals = await env.usage.projectTotals(project.id);
    expect([totals.evaluate.count, totals.regions.count]).toEqual([1, 1]);
  });

  it('crops one portrait file', async () => {
    const crop = await twice(env, `/projects/${project.id}/portraits`, { json: { characterId: 'c-red', sourceTime: 1, x: 0.2, y: 0.1, size: 0.5 } });
    expect(crop.b).toEqual(crop.a);
    expect(await readdir(join(root, project.id, 'portraits'))).toHaveLength(1);
  });

  it('re-ingests with one job', async () => {
    const ingest = await twice(env, `/projects/${project.id}/ingest`, { method: 'POST' });
    expect(ingest.first.status).toBe(202);
    expect(ingest.b).toEqual(ingest.a);
    await env.jobs.whenIdle();
    project = await env.store.read(project.id);
  });

  it('renders once, returns the running render, and cancels and deletes once', async () => {
    const start = await twice(env, `/projects/${project.id}/renders`, { json: { version: project.version } });
    expect(start.first.status).toBe(202);
    expect(start.b).toEqual(start.a);
    const render = RenderJobSchema.parse(start.a);

    // Same version and size from a new request: the same render.
    const same = await env.call(`/projects/${project.id}/renders`, { json: { version: project.version, preset: 'source' } });
    expect(same.status).toBe(200);
    expect(RenderJobSchema.parse(await same.json()).id).toBe(render.id);
    // A different size while it runs: job_running, with the job.
    const other = await env.call(`/projects/${project.id}/renders`, { json: { version: project.version, preset: '1080p' } });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: 'job_running', job: { kind: 'render', state: { id: render.id } } });
    expect(RenderJobSchema.array().parse(await (await env.call(`/projects/${project.id}/renders`)).json())).toHaveLength(1);

    const cancel = await twice(env, `/projects/${project.id}/renders/${render.id}/cancel`, { method: 'POST' });
    expect(cancel.b).toEqual(cancel.a);
    await env.jobs.whenIdle();
    const [cancelled] = RenderJobSchema.array().parse(await (await env.call(`/projects/${project.id}/renders`)).json());
    expect(cancelled?.status).toBe('cancelled');

    const remove = await twice(env, `/projects/${project.id}/renders/${render.id}`, { method: 'DELETE' });
    expect([remove.first.status, remove.second.status]).toEqual([204, 204]);
    expect(await (await env.call(`/projects/${project.id}/renders`)).json()).toEqual([]);
  });

  it('refuses a missing key, and a key reused for another request', async () => {
    const bare = await env.app.request(`/api/v1/projects/${project.id}/analyze`, { method: 'POST' });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ code: 'idempotency_key_required' });
    const key = 'reused-key-0001';
    await env.call(`/projects/${project.id}/portraits`, { json: { characterId: 'c-red', sourceTime: 1, x: 0, y: 0, size: 0.5 }, key });
    const reused = await env.call(`/projects/${project.id}/portraits`, { json: { characterId: 'c-red', sourceTime: 2, x: 0, y: 0, size: 0.5 }, key });
    expect(reused.status).toBe(422);
    expect(await reused.json()).toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('deletes once', async () => {
    const remove = await twice(env, `/projects/${project.id}`, { method: 'DELETE' });
    expect([remove.first.status, remove.second.status]).toEqual([204, 204]);
    const gone = await env.call(`/projects/${project.id}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: 'not_found' });
  });
});

describe('contract rules', { timeout: 30_000 }, () => {
  let root: string;
  let env: TestApp;
  let project: Project;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'als-rules-'));
    // A cap so small that one paid call reaches it.
    env = await makeTestApp(root, {}, undefined, undefined, { capUsd: 0.000001 });
    const fixture = ProjectSchema.parse(JSON.parse(await readFile(new URL('../../../fixtures/sample/project.json', import.meta.url), 'utf8')));
    const id = await env.store.newId('rules');
    project = await env.store.create({ ...fixture, id, version: 1 });
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  it('turns away a client older than the minimum with 426', async () => {
    const old = await env.app.request('/api/v1/health', { headers: { 'X-Client-Version': '0.9.0' } });
    expect(old.status).toBe(426);
    expect(await old.json()).toMatchObject({ code: 'client_too_old' });
    expect((await env.app.request('/api/v1/health', { headers: { 'X-Client-Version': '1.0.0' } })).status).toBe(200);
  });

  it('answers a stale save with version_conflict and the current version', async () => {
    const res = await env.call(`/projects/${project.id}`, { method: 'PUT', json: { version: 7, moments: [], characters: [], themeId: 'default' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'version_conflict', error: expect.any(String), current: 1 });
  });

  it('refuses analysis before ingest with not_ready', async () => {
    await env.store.update(project.id, (p) => {
      p.ingest = { status: 'pending', stages: [] };
    });
    const res = await env.call(`/projects/${project.id}/analyze`, { json: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_ready' });
  });

  it('stops paid calls at the monthly cap with over_cap', async () => {
    const before = MeSchema.parse(await (await env.call('/me')).json());
    expect(before).toMatchObject({ user: { id: LOCAL_USER }, monthlyCapUsd: 0.000001, monthToDateUsd: 0 });
    const regenerate = () => env.call(`/projects/${project.id}/regenerate`, { json: { moment: project.moments[0] } });
    expect((await regenerate()).status).toBe(200);
    const after = MeSchema.parse(await (await env.call('/me')).json());
    expect(after.monthToDateUsd).toBeGreaterThan(0);
    const refused = await regenerate();
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ code: 'over_cap', error: expect.stringMatching(/cap/) });
    expect((await env.usage.projectTotals(project.id)).regenerate.count).toBe(1);
  });

  it('serves media only at a valid, unexpired signature for that project', async () => {
    await writeFile(join(root, project.id, 'proxy.mp4'), 'not really a video');
    const grant = await env.signer.grant(LOCAL_USER, project.id);
    const url = `${grant.base}proxy.mp4?${grant.query}`;
    expect((await env.app.request(url)).status).toBe(200);
    expect((await env.app.request(`${grant.base}proxy.mp4`)).status).toBe(403);
    const expired = await env.signer.sign(`projects/${project.id}/`, LOCAL_USER, -10);
    const stale = await env.app.request(`${grant.base}proxy.mp4?${expired.query}`);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: 'media_url_invalid' });
    // Another project's signature opens nothing here.
    const elsewhere = await env.signer.grant(LOCAL_USER, 'some-other-project');
    expect((await env.app.request(`${grant.base}proxy.mp4?${elsewhere.query}`)).status).toBe(403);
  });

  it('downloads a finished render as an attachment', async () => {
    const id = `v${project.version}-20261104-120000`;
    await mkdir(join(root, project.id, 'renders'), { recursive: true });
    await env.store.editRenders(project.id, (jobs) => {
      jobs.push({ id, projectVersion: project.version, preset: 'source', width: 1280, height: 720, fps: 30, frames: 300, status: 'done', progress: 1, createdAt: new Date().toISOString(), file: `renders/${id}.mp4`, sizeBytes: 4 });
    });
    await writeFile(join(root, project.id, 'renders', `${id}.mp4`), 'mp4!');
    const { url } = (await (await env.call(`/projects/${project.id}/renders/${id}/download`)).json()) as { url: string };
    const file = await env.app.request(url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename=".*\.mp4"$/);
    expect(await file.text()).toBe('mp4!');
  });

  it('resumes an upload from the parts already stored, and checks each part’s size', async () => {
    const size = UPLOAD_PART_BYTES + 1000;
    const created = CreateProjectResultSchema.parse(await (await env.call('/projects', { json: { name: 'big.mov', size } })).json());
    expect(created.upload.partCount).toBe(2);
    const ask = async () =>
      UploadPartsResultSchema.parse(await (await env.call(`/projects/${created.projectId}/upload/parts`, { json: { uploadId: created.upload.uploadId } })).json());
    const { parts } = await ask();
    const short = await env.app.request(parts[0]!.url, { method: 'PUT', body: new Uint8Array(10), headers: { 'content-length': '10' } });
    expect(short.status).toBe(400);
    const first = await env.app.request(parts[0]!.url, {
      method: 'PUT',
      body: new Uint8Array(UPLOAD_PART_BYTES),
      headers: { 'content-length': String(UPLOAD_PART_BYTES) },
    });
    expect(first.status).toBe(200);
    // After a drop, asking again says which parts are already there.
    expect((await ask()).uploaded).toEqual([{ partNumber: 1, etag: first.headers.get('etag')!.replaceAll('"', '') }]);
    // Completing without the last part is refused and keeps what was uploaded.
    const early = await env.call(`/projects/${created.projectId}/upload/complete`, {
      json: { uploadId: created.upload.uploadId, parts: [{ partNumber: 1, etag: first.headers.get('etag')! }, { partNumber: 2, etag: 'x' }] },
    });
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ code: 'upload_incomplete' });
    expect((await ask()).uploaded).toHaveLength(1);
    // A tampered part URL is refused.
    const forged = parts[1]!.url.replace(/sig=[^&]+/, 'sig=nope');
    expect((await env.app.request(forged, { method: 'PUT', body: new Uint8Array(1000), headers: { 'content-length': '1000' } })).status).toBe(403);
  });

  it('uploads through the helper end to end and lists nothing until complete', async () => {
    expect((await (await env.call('/projects')).json()) as unknown[]).toHaveLength(1);
    const res = await uploadFile(env, 'clip.mp4', new Uint8Array(await readFile(new URL('../../../fixtures/sample/source.mp4', import.meta.url))));
    expect(res.status).toBe(201);
    await env.jobs.whenIdle();
    expect((await (await env.call('/projects')).json()) as unknown[]).toHaveLength(2);
  }, 60_000);
});
