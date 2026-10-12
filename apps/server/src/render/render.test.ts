// The Phase 5 render test: renders a 10-second fixture with two moments through the
// real server and checks the MP4 with ffprobe and ffmpeg. It runs headless Chrome,
// so it takes a while; the browser is downloaded on first use.
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serve, type ServerType } from '@hono/node-server';
import { buildTimeline } from '@als/composition/timeline';
import { ProjectSchema, RenderJobSchema, type Project, type RenderJob } from '@als/schema';
import { getTheme } from '@als/theme/themes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingIngest } from '../ingest/ingest.ts';
import { makeTestApp } from '../test-helpers.ts';

const exec = promisify(execFile);
const fixture = (path: string) => fileURLToPath(new URL(`../../../../fixtures/sample/${path}`, import.meta.url));

/** A rendered frame's pixels, decoded. */
async function framePixels(file: string, frame: number): Promise<Buffer> {
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  expect(stdout.length).toBeGreaterThan(0);
  return stdout;
}

/**
 * Largest difference (0-255) between two frames in any channel. Identical input
 * frames do not always decode bit for bit from H.264 (rounding moves a few
 * values by up to about 4), so a freeze is checked against a small tolerance.
 */
async function frameDifference(file: string, a: number, b: number): Promise<number> {
  const [x, y] = await Promise.all([framePixels(file, a), framePixels(file, b)]);
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]! - y[i]!));
  return max;
}
/** Encoder rounding stays under this; any real motion is far above it. */
const SAME_FRAME = 8;

/** Mean audio level (dB) over output seconds [from, from + sec). */
async function meanVolume(file: string, from: number, sec: number): Promise<number> {
  const { stderr } = await exec('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', String(sec), '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
  const match = /mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  return match?.[1] === '-inf' || !match ? -Infinity : Number(match[1]);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('render', { timeout: 300_000 }, () => {
  let root: string;
  let server: ServerType;
  let project: Project;
  let job: RenderJob;
  let output: string;

  let cwd: string;

  beforeAll(async () => {
    // Remotion keeps its browser under the nearest package.json; share the server's copy.
    cwd = process.cwd();
    process.chdir(fileURLToPath(new URL('../..', import.meta.url)));
    root = await mkdtemp(join(tmpdir(), 'als-render-'));
    const port = await freePort();
    const { store, renders, app } = await makeTestApp(root, {}, join(root, 'sounds'), `http://127.0.0.1:${port}`);
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

    // The sample fixture with its first two moments.
    const sample = ProjectSchema.parse(JSON.parse(await readFile(fixture('project.json'), 'utf8')));
    const id = await store.createDir('render');
    await copyFile(fixture('source.mp4'), store.file(id, 'source.mp4'));
    project = await store.create({
      ...sample,
      id,
      version: 1,
      createdAt: new Date().toISOString(),
      source: { ...sample.source, file: 'source.mp4', proxy: 'proxy.mp4' },
      moments: sample.moments.slice(0, 2),
      shots: undefined,
      ingest: pendingIngest(),
    });

    const started = await app.request(`/api/projects/${id}/renders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: project.version }),
    });
    expect(started.status).toBe(202);
    await renders.queue.whenIdle();
    const list = RenderJobSchema.array().parse(await (await app.request(`/api/projects/${id}/renders`)).json());
    job = list[0]!;
    output = store.file(id, job.file);
  }, 300_000);

  afterAll(async () => {
    process.chdir(cwd);
    server?.close();
    if (process.env.KEEP_RENDER) await copyFile(output, process.env.KEEP_RENDER);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('finishes and records the file', () => {
    expect(job.error).toBeUndefined();
    expect(job.status).toBe('done');
    expect(job.sizeBytes).toBeGreaterThan(0);
  });

  it('lasts the source plus both holds, within one frame', async () => {
    const { fps, durationSec } = project.source;
    const holds = project.moments.reduce((sum, m) => sum + m.holdSec, 0);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', output]);
    const stream = JSON.parse(stdout).streams[0];
    expect(Math.abs(Number(stream.duration) - (durationSec + holds))).toBeLessThanOrEqual(1 / fps);
    expect(Number(stream.nb_read_frames)).toBe(buildTimeline(project.moments, fps, durationSec).outFrames);
  });

  it('freezes the frame inside each hold', async () => {
    const { fps } = project.source;
    const { timing } = getTheme(project.themeId);
    const timeline = buildTimeline(project.moments, fps, project.source.durationSec);
    for (const hold of timeline.holds) {
      // Two frames in the reread, after the type-out and before the card leaves, so the card is still too.
      const leave = hold.outStart + hold.frames - Math.ceil(timing.cardOutSec * fps);
      const [a, b] = [leave - Math.round(2 * fps), leave - Math.round(0.5 * fps)];
      expect(await frameDifference(output, a, b), `hold ${hold.momentId}`).toBeLessThanOrEqual(SAME_FRAME);
    }
    // Control: two frames of the same shot a few frames apart during play differ, so the check above can fail.
    const play = timeline.segments[0]!;
    expect(await frameDifference(output, play.outStart + 10, play.outStart + 15)).toBeGreaterThan(50);
  });

  it('silences the source during holds', async () => {
    const { fps } = project.source;
    const timeline = buildTimeline(project.moments, fps, project.source.durationSec);
    for (const hold of timeline.holds) {
      expect(await meanVolume(output, hold.outStart / fps + 0.5, hold.frames / fps - 1)).toBeLessThan(-70);
    }
    // The clip's own tone plays between them.
    expect(await meanVolume(output, 0.2, 1.5)).toBeGreaterThan(-40);
  });
});
