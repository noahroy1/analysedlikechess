import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { shotThumbnailFile, type RenderProps } from '@als/schema';
import type { FsBlobStore } from '../node/fs-blobs.ts';
import { projectKey, type MediaFile, type MediaRunner, type RenderInput } from '../ports.ts';
import { EpisodeBundle } from '../render/bundle.ts';
import { CUT_DETECTION, detectCuts, parseScdet, shotsFromCuts } from './cuts.ts';
import { extractPortrait } from './portrait.ts';
import { probe } from './probe.ts';
import { ffmpeg } from './run.ts';
import { PROXY, THUMB_WIDTH } from './settings.ts';

const THUMB_CONCURRENCY = 4;

/** Must match EPISODE_COMPOSITION in packages/composition/src/render-entry.tsx. */
const COMPOSITION_ID = 'Episode';

/**
 * Quality-first H.264 and AAC, ready for YouTube. Frames are captured raw when
 * the bundled ffmpeg supports shared memory, else as near-lossless JPEGs.
 */
const ENCODING = {
  codec: 'h264',
  crf: 18,
  x264Preset: 'medium',
  audioCodec: 'aac',
  audioBitrate: '320k',
  colorSpace: 'bt709',
  jpegQuality: 95,
} as const;

/** Time allowed for the clip and sounds to load into a frame. A long source can take a while to open. */
const LOAD_TIMEOUT_MS = 120_000;

/**
 * The renderer's browser loads the clip from this server, a different origin
 * from the bundle it is served. It is a local, single-purpose browser, so
 * cross-origin checks are off rather than opening the server to every page with CORS.
 */
const chromiumOptions = { disableWebSecurity: true };

/** ffmpeg and Remotion as local child processes, on the files behind an FsBlobStore. (C2 moves this into `apps/media`.) */
export class LocalMediaRunner implements MediaRunner {
  private readonly blobs: FsBlobStore;
  private readonly bundle: EpisodeBundle;
  private browser: Promise<unknown> | undefined;

  constructor(blobs: FsBlobStore, bundle = new EpisodeBundle()) {
    this.blobs = blobs;
    this.bundle = bundle;
  }

  private path(projectId: string, file: string) {
    return this.blobs.path(projectKey(projectId, file));
  }

  probe({ projectId, file }: MediaFile) {
    return probe(this.path(projectId, file));
  }

  async hash({ projectId, file }: MediaFile, onProgress: (p: number) => void): Promise<string> {
    const path = this.path(projectId, file);
    const { size } = await stat(path);
    const hash = createHash('sha256');
    let read = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
      hash.update(chunk as Buffer);
      read += (chunk as Buffer).length;
      onProgress(size ? read / size : 1);
    }
    return hash.digest('hex');
  }

  async proxy(input: MediaFile & { output: string; fps: number; durationSec: number }, onProgress: (p: number) => void) {
    const out = this.path(input.projectId, input.output);
    const tmp = join(dirname(out), 'proxy.tmp.mp4');
    const gop = String(Math.max(1, Math.round(input.fps)));
    await ffmpeg(
      [
        '-i', this.path(input.projectId, input.file),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', `scale=-2:'trunc(min(${PROXY.maxHeight},ih)/2)*2',format=yuv420p`,
        // Same frame rate as the source, constant, so frame n of the proxy is frame n of the source.
        '-fps_mode', 'cfr', '-r', String(input.fps),
        '-c:v', 'libx264', '-preset', PROXY.preset, '-crf', String(PROXY.crf),
        // A keyframe every second keeps scrubbing smooth.
        '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', `${PROXY.audioKbps}k`, '-ac', '2', '-ar', '48000',
        '-movflags', '+faststart',
        tmp,
      ],
      input.durationSec,
      onProgress,
    );
    await rename(tmp, out);
  }

  async audio(input: MediaFile & { output: string; durationSec: number }, onProgress: (p: number) => void) {
    const out = this.path(input.projectId, input.output);
    const tmp = join(dirname(out), 'audio.tmp.wav');
    // Mono 16 kHz is what speech-to-text APIs expect.
    await ffmpeg(
      ['-i', this.path(input.projectId, input.file), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp],
      input.durationSec,
      onProgress,
    );
    await rename(tmp, out);
  }

  async shots(input: MediaFile & { durationSec: number }, onProgress: (p: number) => void) {
    const output = await ffmpeg(
      [
        '-i', this.path(input.projectId, input.file),
        '-an',
        '-vf', `scale=${CUT_DETECTION.scaleWidth}:-2,scdet=threshold=100,metadata=print:file=-`,
        '-f', 'null', '-',
      ],
      input.durationSec,
      onProgress,
    );
    return shotsFromCuts(detectCuts(parseScdet(output)), input.durationSec);
  }

  async thumbnails(input: MediaFile & { shots: { start: number; end: number }[] }, onProgress: (p: number) => void) {
    const { shots } = input;
    const proxyPath = this.path(input.projectId, input.file);
    const framesDir = dirname(this.path(input.projectId, shotThumbnailFile(0)));
    const tmpDir = `${framesDir}.tmp`;
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < shots.length) {
        const i = next++;
        const shot = shots[i]!;
        // The middle of the shot is more representative than its first frame.
        const mid = (shot.start + shot.end) / 2;
        await ffmpeg(
          [
            '-ss', mid.toFixed(3), '-i', proxyPath,
            '-frames:v', '1', '-an', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '4',
            join(tmpDir, shotThumbnailFile(i).replace('frames/', '')),
          ],
          0,
        );
        onProgress(++done / shots.length);
      }
    };
    await Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker));
    await rm(framesDir, { recursive: true, force: true });
    await rename(tmpDir, framesDir);
  }

  async frame({ projectId, file, frame, fps }: MediaFile & { frame: number; fps: number }): Promise<Uint8Array> {
    // Just under the frame's time, so rounding never lands on the next one.
    const at = Math.max(0, (frame - 0.25) / fps);
    const { stdout } = await promisify(execFile)(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(4), '-i', this.path(projectId, file), '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', '-'],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
    );
    if (!stdout.length) throw new Error(`no frame at ${at.toFixed(3)} s`);
    return stdout;
  }

  async portrait(input: Parameters<MediaRunner['portrait']>[0]) {
    await extractPortrait(this.path(input.projectId, input.file), this.path(input.projectId, input.output), input.request, input.source);
  }

  async render({ projectId, output, props, scale, onProgress, signal }: RenderInput): Promise<{ sizeBytes: number }> {
    signal.throwIfAborted();
    const { makeCancelSignal, renderMedia, selectComposition } = await import('@remotion/renderer');
    const { cancelSignal, cancel } = makeCancelSignal();
    const abort = () => cancel();
    signal.addEventListener('abort', abort);
    if (signal.aborted) cancel();
    const out = this.path(projectId, output);
    const tmp = out.replace(/\.mp4$/, '.tmp.mp4');
    try {
      onProgress({ progress: 0, stage: 'Preparing the browser' });
      await this.ensureBrowser();
      signal.throwIfAborted();
      onProgress({ progress: 0, stage: 'Bundling' });
      const serveUrl = await this.bundle.serveUrl();
      signal.throwIfAborted();

      const inputProps = props as RenderProps;
      const shared = { serveUrl, inputProps, timeoutInMilliseconds: LOAD_TIMEOUT_MS, chromiumOptions, logLevel: 'warn' } as const;
      const composition = await selectComposition({ ...shared, id: COMPOSITION_ID });
      onProgress({ progress: 0, stage: 'Rendering frames', frames: composition.durationInFrames });
      await mkdir(dirname(out), { recursive: true });
      await renderMedia({
        ...shared,
        ...ENCODING,
        composition,
        scale,
        outputLocation: tmp,
        cancelSignal,
        onProgress: ({ progress, stitchStage, renderedFrames }) => {
          const stage = renderedFrames < composition.durationInFrames ? 'Rendering frames' : stitchStage === 'muxing' ? 'Adding audio' : 'Encoding';
          onProgress({ progress: Math.min(progress, 0.99), stage });
        },
        onBrowserLog: (log) => {
          if (log.type === 'error') console.warn(`render ${projectId}/${output}:`, log.text);
        },
      });
      await rename(tmp, out);
      return { sizeBytes: (await stat(out)).size };
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  warmUp(): void {
    void this.ensureBrowser().catch((error: unknown) => console.warn('render browser not ready:', error));
    void this.bundle.serveUrl().catch((error: unknown) => console.warn('render bundle failed:', error));
  }

  private ensureBrowser(): Promise<unknown> {
    // Downloads Chrome Headless Shell the first time.
    this.browser ??= import('@remotion/renderer').then(({ ensureBrowser }) => ensureBrowser());
    this.browser.catch(() => {
      this.browser = undefined;
    });
    return this.browser;
  }
}
