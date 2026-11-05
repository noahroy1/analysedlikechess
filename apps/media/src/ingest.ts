import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROXY, THUMB_WIDTH, type MediaTask, type PortraitTask } from '@als/schema';
import { CUT_DETECTION, detectCuts, parseScdet, shotsFromCuts } from './cuts.ts';
import { download, upload } from './io.ts';
import { extractPortrait } from './portrait.ts';
import { ffmpeg } from './run.ts';

// The ingest steps, the frame grab and the portrait crop. Each reads its input
// from a URL and PUTs its outputs, working in a folder of its own.

type Task<Op extends MediaTask['op']> = Extract<MediaTask, { op: Op }>;

export interface StepContext {
  /** A scratch folder for this task, removed when it ends. */
  work: string;
  progress: (p: number, stage?: string) => void;
  signal: AbortSignal;
}

const THUMB_CONCURRENCY = 4;

/** The 720p proxy, frame for frame with the source. */
export async function proxy(task: Task<'proxy'>, { work, progress, signal }: StepContext): Promise<void> {
  const source = join(work, 'source');
  await download(task.input, source, signal);
  const out = join(work, 'proxy.mp4');
  const gop = String(Math.max(1, Math.round(task.fps)));
  await ffmpeg(
    [
      '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `scale=-2:'trunc(min(${PROXY.maxHeight},ih)/2)*2',format=yuv420p`,
      // Same frame rate as the source, constant, so frame n of the proxy is frame n of the source.
      '-fps_mode', 'cfr', '-r', String(task.fps),
      '-c:v', 'libx264', '-preset', PROXY.preset, '-crf', String(PROXY.crf),
      // A keyframe every second keeps scrubbing smooth.
      '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', `${PROXY.audioKbps}k`, '-ac', '2', '-ar', '48000',
      '-movflags', '+faststart',
      out,
    ],
    task.durationSec,
    (p) => progress(p * 0.95),
    signal,
  );
  await upload(task.output, out, 'video/mp4', signal);
}

/** Mono 16 kHz WAV, what speech-to-text APIs expect. */
export async function audio(task: Task<'audio'>, { work, progress, signal }: StepContext): Promise<void> {
  const source = join(work, 'source');
  await download(task.input, source, signal);
  const out = join(work, 'audio.wav');
  await ffmpeg(['-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], task.durationSec, progress, signal);
  await upload(task.output, out, 'audio/wav', signal);
}

/** Cut detection on the proxy. */
export async function shots(task: Task<'shots'>, { work, progress, signal }: StepContext) {
  const input = join(work, 'proxy.mp4');
  await download(task.input, input, signal);
  const output = await ffmpeg(
    ['-i', input, '-an', '-vf', `scale=${CUT_DETECTION.scaleWidth}:-2,scdet=threshold=100,metadata=print:file=-`, '-f', 'null', '-'],
    task.durationSec,
    progress,
    signal,
  );
  return shotsFromCuts(detectCuts(parseScdet(output)), task.durationSec);
}

/** One thumbnail per shot, from its middle (more representative than its first frame). */
export async function thumbnails(task: Task<'thumbnails'>, { work, progress, signal }: StepContext): Promise<void> {
  if (task.outputs.length !== task.shots.length) throw new Error('one output per shot');
  const input = join(work, 'proxy.mp4');
  await download(task.input, input, signal);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < task.shots.length) {
      const i = next++;
      const shot = task.shots[i]!;
      const out = join(work, `shot-${i}.jpg`);
      const mid = (shot.start + shot.end) / 2;
      await ffmpeg(['-ss', mid.toFixed(3), '-i', input, '-frames:v', '1', '-an', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '4', out], 0, undefined, signal);
      await upload(task.outputs[i]!, out, 'image/jpeg', signal);
      await rm(out, { force: true });
      progress(++done / task.shots.length);
    }
  };
  await Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker));
}

/**
 * One frame (same frame numbers as the source) as a JPEG. ffmpeg seeks in the
 * URL with Range requests, so only the bytes around the frame are read.
 */
export async function frame(input: string, frameNumber: number, fps: number): Promise<Uint8Array> {
  // Just under the frame's time, so rounding never lands on the next one.
  const at = Math.max(0, (frameNumber - 0.25) / fps);
  const { stdout } = await promisify(execFile)(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(4), '-i', input, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', '-'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  );
  if (!stdout.length) throw new Error(`no frame at ${at.toFixed(3)} s`);
  return stdout;
}

/** Crops a square portrait from one frame of the source and PUTs it. */
export async function portrait(task: PortraitTask, work: string): Promise<void> {
  const out = join(work, 'portrait.jpg');
  await extractPortrait(task.input, out, task.request, task.source);
  await upload(task.output, out, 'image/jpeg');
}
