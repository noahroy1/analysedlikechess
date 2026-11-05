// The render test: renders a 10-second fixture with two moments through the media
// service, the way the API asks for it (chunks by frame range, then the join), and
// checks the MP4 with ffprobe and ffmpeg. It renders the episode whole and in three
// chunks, and checks the chunked one against the whole one around every seam. It runs
// headless Chrome, so it takes a while; the browser is downloaded on first use.
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serve, type ServerType } from '@hono/node-server';
import { buildTimeline } from '@als/composition/timeline';
import {
  MediaTaskEventSchema,
  ProjectSchema,
  RENDER_ENCODING,
  chunkRanges,
  episodeProps,
  gameReviewSec,
  type MediaTask,
  type MediaTaskEvent,
  type MediaTaskResult,
  type Project,
} from '@als/schema';
import { getTheme } from '@als/theme/themes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMediaServer } from './server.ts';

const exec = promisify(execFile);
const fixture = (path: string) => fileURLToPath(new URL(`../../../fixtures/sample/${path}`, import.meta.url));

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

/** Mean difference (0-255) and PSNR (dB) between two frames, possibly of two files. */
async function frameDifference(a: [string, number], b: [string, number]): Promise<{ mean: number; psnr: number }> {
  const [x, y] = await Promise.all([framePixels(...a), framePixels(...b)]);
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i]! - y[i]!);
    sum += d;
    squares += d * d;
  }
  return { mean: sum / x.length, psnr: squares ? 10 * Math.log10((255 ** 2 * x.length) / squares) : Infinity };
}

/**
 * Identical input frames do not decode bit for bit from H.264: across a keyframe
 * (one starts every chunk, and x264 puts one every 250 frames anyway) a frozen
 * frame is quantised afresh, moving edges by up to about 60 levels while the
 * frame stays at 48-50 dB. Measured Nov 5 on the sample: holds 48.7-80 dB, play
 * frames five apart 29.9 dB. So a freeze is at least this, motion far below.
 */
const SAME_FRAME_DB = 45;
const MOTION_DB = 35;
/** Two encodes of the same frame. */
const SAME_PICTURE_DB = 35;
/** The largest step a keyframe makes in a frozen frame. */
const KEYFRAME_STEP_DB = 40;

/** Mean audio level (dB) over output seconds [from, from + sec). */
async function meanVolume(file: string, from: number, sec: number): Promise<number> {
  const { stderr } = await exec('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', String(sec), '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
  const match = /mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  return match?.[1] === '-inf' || !match ? -Infinity : Number(match[1]);
}

/** The audio as mono 48 kHz floats. */
async function samples(file: string): Promise<Float32Array> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

/** RMS (dB) of the difference between two signals over [from, to) seconds. */
function differenceDb(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let sum = 0;
  const [start, end] = [Math.round(from * 48000), Math.min(a.length, b.length, Math.round(to * 48000))];
  for (let i = start; i < end; i++) sum += (a[i]! - b[i]!) ** 2;
  return 10 * Math.log10(sum / Math.max(1, end - start) + 1e-20);
}

/**
 * A stand-in for the API's side of the media contract: GET serves files (with
 * Range), PUT stores them, POST /callback/<id> delivers a task's events.
 */
async function standIn(dir: string) {
  const waiting = new Map<string, (event: MediaTaskEvent) => void>();
  const server: Server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (req.method === 'POST' && path.startsWith('/callback/')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const event = MediaTaskEventSchema.parse(JSON.parse(body));
      waiting.get(event.id)?.(event);
      return res.writeHead(200).end();
    }
    const file = join(dir, path);
    if (req.method === 'PUT') {
      await mkdir(dirname(file), { recursive: true });
      await pipeline(req, createWriteStream(file));
      return res.writeHead(200).end();
    }
    const size = await stat(file).then((s) => s.size, () => undefined);
    if (size === undefined) return res.writeHead(404).end();
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const [start, end] = [Number(range[1]), range[2] ? Math.min(Number(range[2]), size - 1) : size - 1];
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin, waiting };
}

describe('render', { timeout: 300_000 }, () => {
  let root: string;
  let media: ServerType;
  let api: Awaited<ReturnType<typeof standIn>>;
  let project: Project;
  let frames: number;
  let whole: string;
  let chunked: string;
  let seams: number[];
  let cwd: string;

  beforeAll(async () => {
    // Remotion keeps its browser under the nearest package.json: this service's.
    cwd = process.cwd();
    process.chdir(fileURLToPath(new URL('..', import.meta.url)));
    root = await mkdtemp(join(tmpdir(), 'als-render-'));
    const files = join(root, 'files');
    api = await standIn(files);
    const service = createMediaServer({ workRoot: join(root, 'work') });
    media = serve({ fetch: service.app.fetch, port: 0, hostname: '127.0.0.1' });
    if (!media.listening) await new Promise((resolve) => media.once('listening', resolve));
    const mediaUrl = `http://127.0.0.1:${(media.address() as AddressInfo).port}/v1`;

    // The sample fixture with its first two moments, served like a project's files.
    const sample = ProjectSchema.parse(JSON.parse(await readFile(fixture('project.json'), 'utf8')));
    project = { ...sample, moments: sample.moments.slice(0, 2) };
    await mkdir(files, { recursive: true });
    await pipeline(createReadStream(fixture('source.mp4')), createWriteStream(join(files, 'source.mp4')));
    const { source } = project;
    const theme = getTheme(project.themeId);
    const props = {
      ...episodeProps(
        { ...project, characters: project.context.characters, durationSec: source.durationSec },
        { src: `${api.origin}/source.mp4`, theme, fileUrl: (file) => `${api.origin}/${file}`, sounds: {} },
      ),
      fps: source.fps,
      width: source.width,
      height: source.height,
    };
    frames = buildTimeline(project.moments, source.fps, source.durationSec, gameReviewSec(theme)).outFrames;

    let n = 0;
    const task = (body: MediaTask) =>
      new Promise<MediaTaskResult>((resolve, reject) => {
        const id = `render-test-${++n}`;
        api.waiting.set(id, (event) => {
          if (event.type === 'done') resolve(event.result);
          if (event.type === 'failed') reject(new Error(event.error));
        });
        void fetch(`${mediaUrl}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, id, callback: `${api.origin}/callback/${id}` }) }).then(
          async (res) => {
            if (res.status !== 202) reject(new Error(`start: ${res.status} ${await res.text()}`));
          },
        );
      });
    /** Renders the episode in `count` chunks and joins them, as the API does. */
    const render = async (name: string, count: number, share: number) => {
      const { ranges, framesPerChunk } = chunkRanges(frames, count);
      const part = (i: number, ext: string) => `${name}/chunk-${i}.${ext}`;
      await Promise.all(
        ranges.map((frameRange, i) =>
          task({ op: 'render-chunk', props, scale: 1, frameRange, encoding: RENDER_ENCODING, video: `${api.origin}/${part(i, 'ts')}`, audio: `${api.origin}/${part(i, 'aac')}`, share }),
        ),
      );
      const joined = await task({
        op: 'combine',
        videos: ranges.map((_, i) => `${api.origin}/${part(i, 'ts')}`),
        audios: ranges.map((_, i) => `${api.origin}/${part(i, 'aac')}`),
        output: `${api.origin}/${name}.mp4`,
        fps: source.fps,
        framesPerChunk,
        durationInFrames: frames,
        encoding: RENDER_ENCODING,
      });
      expect(joined.sizeBytes).toBeGreaterThan(0);
      return { file: join(files, `${name}.mp4`), seams: ranges.slice(1).map(([from]) => from) };
    };
    // Both at once, sharing the machine.
    const [a, b] = await Promise.all([render('whole', 1, 4), render('chunked', 3, 4)]);
    whole = a.file;
    chunked = b.file;
    seams = b.seams;
  }, 300_000);

  afterAll(async () => {
    process.chdir(cwd);
    media?.close();
    api?.server.close();
    if (process.env.KEEP_RENDER) await exec('cp', [chunked, process.env.KEEP_RENDER]);
    if (process.env.KEEP_WHOLE) await exec('cp', [whole, process.env.KEEP_WHOLE]);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('lasts the source plus both holds, within one frame, in every frame', async () => {
    const { fps, durationSec } = project.source;
    const holds = project.moments.reduce((sum, m) => sum + m.holdSec, 0);
    for (const file of [whole, chunked]) {
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,duration,color_space,color_primaries,color_transfer', '-of', 'json', file]);
      const stream = JSON.parse(stdout).streams[0];
      expect(Math.abs(Number(stream.duration) - (durationSec + holds))).toBeLessThanOrEqual(1 / fps);
      expect(Number(stream.nb_read_frames)).toBe(frames);
      expect(stream).toMatchObject({ color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709' });
    }
  });

  it('freezes the frame inside each hold', async () => {
    const { fps } = project.source;
    const { timing } = getTheme(project.themeId);
    const timeline = buildTimeline(project.moments, fps, project.source.durationSec);
    for (const hold of timeline.holds) {
      // Two frames in the reread, after the type-out and before the card leaves, so the card is still too.
      const leave = hold.outStart + hold.frames - Math.ceil(timing.cardOutSec * fps);
      const [a, b] = [leave - Math.round(2 * fps), leave - Math.round(0.5 * fps)];
      expect((await frameDifference([chunked, a], [chunked, b])).psnr, `hold ${hold.momentId}`).toBeGreaterThanOrEqual(SAME_FRAME_DB);
    }
    // Control: two frames of the same shot a few frames apart during play differ, so the check above can fail.
    const play = timeline.segments[0]!;
    expect((await frameDifference([chunked, play.outStart + 10], [chunked, play.outStart + 15])).psnr).toBeLessThan(MOTION_DB);
  });

  it('silences the source during holds', async () => {
    const { fps } = project.source;
    const timeline = buildTimeline(project.moments, fps, project.source.durationSec);
    for (const hold of timeline.holds) {
      expect(await meanVolume(chunked, hold.outStart / fps + 0.5, hold.frames / fps - 1)).toBeLessThan(-70);
    }
    // The clip's own tone plays between them.
    expect(await meanVolume(chunked, 0.2, 1.5)).toBeGreaterThan(-40);
  });

  it('joins chunks with no visible seam', async () => {
    expect(seams).toHaveLength(2);
    for (const seam of seams) {
      // The same picture as the whole render on both sides. Two encodes drift apart between keyframes
      // (38-56 dB on the sample, far from any seam), so this is render-checks' "same picture", not "same bits".
      for (const frame of [seam - 1, seam, seam + 1]) {
        expect((await frameDifference([whole, frame], [chunked, frame])).psnr, `frame ${frame}`).toBeGreaterThanOrEqual(SAME_PICTURE_DB);
      }
      // A seam starts a keyframe, and steps no more than one: the whole render's own keyframes in holds
      // step 44.2-48.7 dB and the seams 43.4-49.4 (Nov 5), where play moves about 30 dB a frame.
      expect((await frameDifference([chunked, seam - 1], [chunked, seam])).psnr, `step at ${seam}`).toBeGreaterThanOrEqual(KEYFRAME_STEP_DB);
    }
  });

  it('joins chunks with no audible seam: the audio matches the whole render', async () => {
    const [a, b] = await Promise.all([samples(whole), samples(chunked)]);
    expect(Math.abs(a.length - b.length)).toBeLessThan(48000 / 50);
    const { fps } = project.source;
    // Control: the clip's tone itself is loud, so a click or gap at a seam would show far above this.
    expect(differenceDb(a, new Float32Array(a.length), 0.2, 1.7)).toBeGreaterThan(-40);
    for (const seam of seams) {
      const at = seam / fps;
      expect(differenceDb(a, b, at - 0.25, at + 0.25), `seam at ${at.toFixed(2)} s`).toBeLessThan(-60);
    }
    expect(differenceDb(a, b, 0, a.length / 48000)).toBeLessThan(-60);
  });
});
