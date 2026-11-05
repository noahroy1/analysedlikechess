import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectSchema, RenderJobSchema, type Project } from '@als/schema';
import { projectKey, type MediaRunner } from '../ports.ts';
import { makeTestApp } from '../test-helpers.ts';
import { chunkCount, renderId } from './renders.ts';

// Requests the render service refuses before anything renders. The render itself is in render.test.ts.
const FIXTURE = new URL('../../../../fixtures/sample/project.json', import.meta.url);

const root = await mkdtemp(join(tmpdir(), 'als-renders-'));
const { store, call } = await makeTestApp(root);
let project: Project;

afterAll(() => rm(root, { recursive: true, force: true }));

beforeEach(async () => {
  const fixture = ProjectSchema.parse(JSON.parse(await readFile(FIXTURE, 'utf8')));
  const id = await store.newId('renders');
  project = await store.create({ ...fixture, id, version: 3 });
});

const post = (body: unknown) =>
  call(`/projects/${project.id}/renders`, { json: body });

describe('render requests', () => {
  it('lists no renders for a new project', async () => {
    const res = await call(`/projects/${project.id}/renders`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('renders only the current saved version', async () => {
    const res = await post({ version: 2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'version_conflict', current: 3 });
  });

  it('refuses a size the clip does not scale to evenly', async () => {
    await store.update(project.id, (p) => {
      p.source = { ...p.source, width: 1000, height: 562 };
    });
    const res = await post({ version: 4, preset: '1080p' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'render_preset', error: expect.stringMatching(/1080p/) });
  });

  it('404s an unknown render or project', async () => {
    expect((await call(`/projects/${project.id}/renders/v1-20260101-000000/cancel`, { method: 'POST' })).status).toBe(404);
    expect((await call('/projects/nope/renders')).status).toBe(404);
  });
});

describe('renderId', () => {
  it('names a render by version and local time', () => {
    expect(renderId(12, new Date(2026, 9, 13, 5, 7, 9))).toBe('v12-20261013-050709');
  });
});

describe('split renders', () => {
  type ChunkCall = Parameters<MediaRunner['renderChunk']>[0];
  type CombineCall = Parameters<MediaRunner['combine']>[0];

  /** A media runner whose chunks and join are recorded; `failChunk` makes one chunk fail and waits for the others to be stopped. */
  async function splitApp(failChunk?: number) {
    const chunks: ChunkCall[] = [];
    const combines: CombineCall[] = [];
    const aborted: number[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'als-split-'));
    const env = await makeTestApp(dir, {}, undefined, {
      renderSplit: { maxChunks: 3, minChunkFrames: 100 },
      wrapMedia: (media) =>
        Object.assign(Object.create(media) as MediaRunner, {
          async renderChunk(input: ChunkCall) {
            const index = chunks.push(input) - 1;
            await env.blobs.put(projectKey(input.projectId, input.video), 'ts');
            if (index === failChunk) throw new Error('chunk exploded');
            if (failChunk === undefined) return { seconds: 2 };
            // The others run until they are stopped.
            await new Promise((_, reject) => input.signal.addEventListener('abort', () => (aborted.push(index), reject(new Error('stopped')))));
            return { seconds: 0 };
          },
          async combine(input: CombineCall) {
            combines.push(input);
            await env.blobs.put(projectKey(input.projectId, input.output), 'mp4!');
            return { sizeBytes: 4, seconds: 1 };
          },
        }),
    });
    const fixture = ProjectSchema.parse(JSON.parse(await readFile(FIXTURE, 'utf8')));
    const created = await env.store.create({ ...fixture, id: await env.store.newId('split'), version: 1 });
    return { env, dir, project: created, chunks, combines, aborted };
  }

  it('renders frame ranges at once, joins them in order and removes the chunks', async () => {
    const { env, dir, project, chunks, combines } = await splitApp();
    const started = RenderJobSchema.parse(await (await env.call(`/projects/${project.id}/renders`, { json: { version: 1 } })).json());
    await env.jobs.whenIdle();
    const [job] = RenderJobSchema.array().parse(await (await env.call(`/projects/${project.id}/renders`)).json());
    expect(job).toMatchObject({ status: 'done', sizeBytes: 4 });
    // Three chunks cover every frame once, in order, all but the last the same length.
    const ranges = chunks.map((c) => c.frameRange).sort((a, b) => a[0] - b[0]);
    expect(ranges).toHaveLength(3);
    expect(ranges[0]![0]).toBe(0);
    expect(ranges.at(-1)![1]).toBe(started.frames - 1);
    ranges.slice(1).forEach(([from], i) => expect(from).toBe(ranges[i]![1] + 1));
    expect(chunks.every((c) => c.chunks === 3)).toBe(true);
    expect(combines).toHaveLength(1);
    expect(combines[0]).toMatchObject({ framesPerChunk: ranges[0]![1] + 1, durationInFrames: started.frames, output: started.file });
    expect(combines[0]!.videos).toEqual(chunks.map((c) => c.video).sort());
    expect(await readdir(join(dir, project.id, 'renders'))).not.toContain(`${started.id}.parts`);
    // Container seconds: every chunk's plus the join's.
    const usage = (await readFile(join(dir, '.usage', 'usage.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { call: string; containerSec?: number });
    expect(usage.find((u) => u.call === 'render')?.containerSec).toBe(7);
    await rm(dir, { recursive: true, force: true });
  });

  it('stops the other chunks when one fails, and fails the render', async () => {
    const { env, dir, project, combines, aborted } = await splitApp(1);
    await env.call(`/projects/${project.id}/renders`, { json: { version: 1 } });
    await env.jobs.whenIdle();
    const [job] = RenderJobSchema.array().parse(await (await env.call(`/projects/${project.id}/renders`)).json());
    expect(job).toMatchObject({ status: 'failed', error: 'chunk exploded' });
    expect(aborted.sort()).toEqual([0, 2]);
    expect(combines).toHaveLength(0);
    expect(await readdir(join(dir, project.id, 'renders'))).not.toContain(`${job!.id}.parts`);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('chunkCount', () => {
  it('keeps chunks at least the minimum long, and at most the maximum many', () => {
    expect(chunkCount(5350, { maxChunks: 4, minChunkFrames: 600 })).toBe(4);
    expect(chunkCount(1320, { maxChunks: 4, minChunkFrames: 600 })).toBe(2);
    expect(chunkCount(300, { maxChunks: 4, minChunkFrames: 600 })).toBe(1);
  });
});
