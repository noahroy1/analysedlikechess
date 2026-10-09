import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectSchema, ProjectSummarySchema, type Project } from '@als/schema';
import type { createApp } from './app.ts';
import type { IngestQueue } from './ingest/queue.ts';
import { run } from './media/run.ts';
import type { ProjectStore } from './projects/store.ts';
import { makeTestApp } from './test-helpers.ts';

// End to end against real ffmpeg (local, no cloud calls) on the 10 s fixture clip,
// which has hard cuts at 3.5 s and 7 s.
const FIXTURE = new URL('../../../fixtures/sample/source.mp4', import.meta.url);

let root: string;
let store: ProjectStore;
let queue: IngestQueue;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'als-test-'));
  ({ store, queue, app } = await makeTestApp(root));
});

afterAll(async () => {
  await queue.whenIdle();
  await rm(root, { recursive: true, force: true });
});

const upload = async (name: string, body: RequestInit['body'], query = '') =>
  app.request(`/api/projects?name=${encodeURIComponent(name)}${query}`, { method: 'POST', body });

const mtimes = async (dir: string) => {
  const files = [
    ...(await readdir(dir)).filter((f) => f !== 'frames'),
    ...(await readdir(join(dir, 'frames'))).map((f) => `frames/${f}`),
  ];
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, (await stat(join(dir, f))).mtimeMs])));
};

describe('health', () => {
  it('answers', async () => {
    const res = await app.request('/api/health');
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('upload validation', () => {
  it('rejects unsupported extensions', async () => {
    const res = await upload('notes.txt', 'hello');
    expect(res.status).toBe(400);
  });

  it('rejects a file that is not a video and leaves nothing behind', async () => {
    const res = await upload('fake.mp4', 'definitely not a video');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/not a playable video/) });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('ingest', () => {
  let project: Project;
  let dir: string;

  beforeAll(async () => {
    const res = await upload('Sample Clip.MP4', await readFile(FIXTURE), '&movieTitle=Synthetic');
    expect(res.status).toBe(201);
    project = ProjectSchema.parse(await res.json());
    dir = store.dir(project.id);
    await queue.whenIdle();
    project = await store.read(project.id);
  }, 60_000);

  it('creates a readable project from the upload', () => {
    expect(project.id).toMatch(/^sample-clip-[0-9a-f]{4}$/);
    expect(project.context.movieTitle).toBe('Synthetic');
    expect(project.source).toMatchObject({
      file: 'source.mp4',
      originalName: 'Sample Clip.MP4',
      fps: 30,
      width: 1280,
      height: 720,
      hasAudio: true,
    });
    expect(project.source.durationSec).toBeCloseTo(10, 1);
  });

  it('finishes every stage', () => {
    expect(project.ingest.status).toBe('done');
    expect(project.ingest.stages.map((s) => [s.name, s.status])).toEqual([
      ['hash', 'done'],
      ['probe', 'done'],
      ['proxy', 'done'],
      ['audio', 'done'],
      ['shots', 'done'],
      ['thumbnails', 'done'],
    ]);
  });

  it('makes a scrubbable H.264 proxy with a keyframe every second', async () => {
    const streams = JSON.parse(
      await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(dir, 'proxy.mp4')]),
    ).streams;
    expect(streams.map((s: { codec_name: string }) => s.codec_name)).toEqual(['h264', 'aac']);
    const keyframes = (
      await run('ffprobe', [
        '-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey',
        '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', join(dir, 'proxy.mp4'),
      ])
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => Number.parseFloat(line));
    expect(keyframes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('extracts mono 16 kHz audio', async () => {
    const [audio] = JSON.parse(
      await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(dir, 'audio.wav')]),
    ).streams;
    expect(audio).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 });
  });

  it('finds the two cuts to within one frame', () => {
    const frame = 1 / project.source.fps;
    expect(project.shots).toHaveLength(3);
    const [a, b, c] = project.shots!;
    expect(a!.start).toBe(0);
    expect(Math.abs(a!.end - 3.5)).toBeLessThanOrEqual(frame);
    expect(Math.abs(b!.end - 7)).toBeLessThanOrEqual(frame);
    expect(c!.end).toBe(project.source.durationSec);
  });

  it('writes one thumbnail per shot', async () => {
    expect(await readdir(join(dir, 'frames'))).toEqual(['shot-0000.jpg', 'shot-0001.jpg', 'shot-0002.jpg']);
  });

  it('lists the project with a poster', async () => {
    const list = ProjectSummarySchema.array().parse(await (await app.request('/api/projects')).json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: project.id, name: 'Synthetic', shotCount: 3, poster: 'frames/shot-0001.jpg' });
  });

  it('serves the proxy with byte ranges so the browser can seek', async () => {
    const res = await app.request(`/api/projects/${project.id}/files/proxy.mp4`, { headers: { Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('refuses to serve files outside the allowlist', async () => {
    for (const name of ['project.json', 'ingest.json', '..%2F..%2Fetc%2Fpasswd', 'audio.wav']) {
      const res = await app.request(`/api/projects/${project.id}/files/${name}`);
      expect(res.status).toBe(404);
    }
  });

  it('is a no-op when re-run on the same file', async () => {
    const before = await mtimes(dir);
    const res = await app.request(`/api/projects/${project.id}/ingest`, { method: 'POST' });
    expect(res.status).toBe(202);
    await queue.whenIdle();
    const rerun = await store.read(project.id);

    expect(rerun.ingest.status).toBe('done');
    expect(rerun.ingest.stages.every((s) => s.status === 'cached')).toBe(true);
    expect(rerun.shots).toEqual(project.shots);
    const after = await mtimes(dir);
    // Only the bookkeeping file changes; every media output is untouched.
    delete before['project.json'];
    delete after['project.json'];
    expect(after).toEqual(before);
  });

  it('rebuilds only what is missing', async () => {
    await rm(join(dir, 'frames', 'shot-0001.jpg'));
    await app.request(`/api/projects/${project.id}/ingest`, { method: 'POST' });
    await queue.whenIdle();
    const rerun = await store.read(project.id);
    expect(rerun.ingest.stages.map((s) => [s.name, s.status])).toEqual([
      ['hash', 'cached'],
      ['probe', 'cached'],
      ['proxy', 'cached'],
      ['audio', 'cached'],
      ['shots', 'cached'],
      ['thumbnails', 'done'],
    ]);
  });

  it('deletes the project', async () => {
    const res = await app.request(`/api/projects/${project.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await app.request(`/api/projects/${project.id}`)).status).toBe(404);
  });
});
