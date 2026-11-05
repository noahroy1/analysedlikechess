import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaGrantSchema, ProjectSchema, ProjectSummarySchema, grantUrl, type MediaGrant, type Project } from '@als/schema';
import { makeTestApp, uploadFile, type TestApp } from './test-helpers.ts';

/** A command's stdout. */
const run = async (command: string, args: string[]) => (await promisify(execFile)(command, args)).stdout;

// End to end against real ffmpeg (local, no cloud calls) on the 10 s fixture clip,
// which has hard cuts at 3.5 s and 7 s.
const FIXTURE = new URL('../../../fixtures/sample/source.mp4', import.meta.url);

let root: string;
let env: TestApp;
let store: TestApp['store'];
let call: TestApp['call'];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'als-test-'));
  env = await makeTestApp(root);
  ({ store, call } = env);
});

afterAll(async () => {
  await env.jobs.whenIdle();
  await rm(root, { recursive: true, force: true });
});

const upload = (name: string, body: string | Uint8Array, context: Record<string, unknown> = {}) =>
  uploadFile(env, name, typeof body === 'string' ? new TextEncoder().encode(body) : body, context);

/** A project file's URL under a fresh grant. */
const signed = async (id: string, file: string) => {
  const grant: MediaGrant = MediaGrantSchema.parse(await (await call(`/projects/${id}/media`)).json());
  return grantUrl(grant, file);
};

const mtimes = async (dir: string) => {
  const files = [
    ...(await readdir(dir)).filter((f) => f !== 'frames'),
    ...(await readdir(join(dir, 'frames'))).map((f) => `frames/${f}`),
  ];
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, (await stat(join(dir, f))).mtimeMs])));
};

describe('health', () => {
  it('answers', async () => {
    const res = await call('/health');
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('upload validation', () => {
  it('rejects unsupported extensions', async () => {
    const res = await upload('notes.txt', 'hello');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_request', error: expect.stringMatching(/MP4, MOV, MKV/) });
  });

  it('rejects a file that is not a video and leaves nothing behind', async () => {
    const res = await upload('fake.mp4', 'definitely not a video');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'not_a_video', error: expect.stringMatching(/not a playable video/) });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('ingest', () => {
  let project: Project;
  let dir: string;

  beforeAll(async () => {
    const res = await upload('Sample Clip.MP4', await readFile(FIXTURE), { movieTitle: 'Synthetic' });
    expect(res.status).toBe(201);
    project = ProjectSchema.parse(await res.json());
    dir = env.dir(project.id);
    await env.jobs.whenIdle();
    project = await store.read(project.id);
  }, 60_000);

  it('creates a readable project from the upload', () => {
    expect(project.id).toMatch(/^sample-clip-[0-9a-f]{4}$/);
    expect(project.context.movieTitle).toBe('Synthetic');
    // Projects use one look.
    expect(project.themeId).toBe('creator');
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
    const list = ProjectSummarySchema.array().parse(await (await call('/projects')).json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: project.id, name: 'Synthetic', shotCount: 3, poster: 'frames/shot-0001.jpg' });
  });

  it('serves the proxy with byte ranges so the browser can seek', async () => {
    const res = await env.app.request(await signed(project.id, 'proxy.mp4'), { headers: { Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    const tail = await env.app.request(await signed(project.id, 'proxy.mp4'), { headers: { Range: 'bytes=-10' } });
    expect((await tail.arrayBuffer()).byteLength).toBe(10);
    const past = await env.app.request(await signed(project.id, 'proxy.mp4'), { headers: { Range: 'bytes=999999999-' } });
    expect(past.status).toBe(416);
    // Revalidation: the same file again is a 304.
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^".+"$/);
    expect((await env.app.request(await signed(project.id, 'proxy.mp4'), { headers: { 'If-None-Match': etag } })).status).toBe(304);
  });

  it('crops a square portrait from one frame, serves it, and leaves the project unsaved', async () => {
    const before = (await store.read(project.id)).version;
    const res = await call(`/projects/${project.id}/portraits`, { json: { characterId: 'c-red', sourceTime: 1, x: 0.3, y: 0.2, size: 0.5 } });
    expect(res.status).toBe(200);
    const { file } = (await res.json()) as { file: string };
    expect(file).toMatch(/^portraits\/c-red-[0-9a-f]{8}\.jpg$/);
    const size = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, file)]);
    expect(size.trim()).toBe('256,256');
    expect((await env.app.request(await signed(project.id, file))).status).toBe(200);
    expect((await store.read(project.id)).version).toBe(before);
  });

  it('refuses to serve files outside the allowlist', async () => {
    for (const name of ['project.json', 'ingest.json', '..%2F..%2Fetc%2Fpasswd', 'audio.wav']) {
      const res = await env.app.request(await signed(project.id, name));
      expect(res.status).toBe(404);
    }
  });

  it('is a no-op when re-run on the same file', async () => {
    const before = await mtimes(dir);
    const res = await call(`/projects/${project.id}/ingest`, { method: 'POST' });
    expect(res.status).toBe(202);
    await env.jobs.whenIdle();
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
    await call(`/projects/${project.id}/ingest`, { method: 'POST' });
    await env.jobs.whenIdle();
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
    const res = await call(`/projects/${project.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await call(`/projects/${project.id}`)).status).toBe(404);
  });
});
