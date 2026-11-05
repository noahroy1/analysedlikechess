import { z } from 'zod';
import { PortraitRequestSchema } from './api.ts';

// The media service (`apps/media`): ffmpeg and Remotion behind HTTP. The API
// calls it through `MediaRunner`; on Node that is a local process (`MEDIA_URL`),
// in the cloud a Container. It never shares a disk with the API: every input is
// a URL it reads (GET, with Range) and every output a URL it writes (PUT), so
// signed API routes today and presigned R2 URLs later look the same to it.

// Media settings that are part of ingest cache keys, shared by the ingest steps and the service that runs them.

export const PROXY = { maxHeight: 720, crf: 23, preset: 'veryfast', audioKbps: 128 };
export const THUMB_WIDTH = 320;

/**
 * Cut detection settings, tuned on dark, low-contrast film footage where real
 * cuts score only 5-10 while fast motion ramps smoothly through 2-5.
 * A cut is a frame that spikes well above its neighbours, or any huge jump.
 */
export const CUT_DETECTION = {
  /** Width frames are scaled to before scoring; scdet scores depend on it. */
  scaleWidth: 320,
  /** Ignore frames scoring below this (scdet's 0-100 scale). */
  minScore: 4,
  /** ...unless they score at least this many times every neighbour in the window. */
  peakRatio: 2,
  windowSec: 0.1,
  /** Always a cut, whatever the neighbours do. */
  hardScore: 10,
  /** Two cuts closer than this keep only the stronger one. */
  minShotSec: 0.2,
};

const Url = z.url({ protocol: /^https?$/ });
const Sec = z.number().nonnegative();

// Quick calls, answered in the response.

export const ProbeTaskSchema = z.object({ input: Url });
export const FrameTaskSchema = z.object({ input: Url, frame: z.int().nonnegative(), fps: z.number().positive() });
export const PortraitTaskSchema = z.object({
  input: Url,
  output: Url,
  request: PortraitRequestSchema,
  source: z.object({ width: z.int().positive(), height: z.int().positive(), durationSec: Sec }),
});
export type PortraitTask = z.infer<typeof PortraitTaskSchema>;

export const ProbeResultSchema = z.object({
  fps: z.number().positive(),
  durationSec: z.number().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  hasAudio: z.boolean(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

// Tasks: started with POST /v1/tasks, answered 202, then progress and the
// result go to `callback` (and GET /v1/tasks/:id answers the same).

const ShotRangeSchema = z.object({ start: Sec, end: Sec });

/** Encoder settings every chunk of a render shares, so the chunks join seamlessly. */
export const RenderEncodingSchema = z.object({
  crf: z.int().min(0).max(51),
  x264Preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']),
  audioBitrate: z.string().regex(/^\d+k$/),
  jpegQuality: z.int().min(1).max(100),
});
export type RenderEncoding = z.infer<typeof RenderEncodingSchema>;

/** Quality-first H.264 and AAC, ready for YouTube. */
export const RENDER_ENCODING: RenderEncoding = { crf: 18, x264Preset: 'medium', audioBitrate: '320k', jpegQuality: 95 };

export const MediaTaskSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hash'), input: Url }),
  z.object({ op: z.literal('proxy'), input: Url, output: Url, fps: z.number().positive(), durationSec: Sec }),
  z.object({ op: z.literal('audio'), input: Url, output: Url, durationSec: Sec }),
  z.object({ op: z.literal('shots'), input: Url, durationSec: Sec }),
  /** One output per shot, in order. */
  z.object({ op: z.literal('thumbnails'), input: Url, shots: z.array(ShotRangeSchema), outputs: z.array(Url) }),
  /**
   * Frames [from, to] (inclusive) of the episode, as an H.264 transport stream
   * and its AAC audio, for `combine`. Every http(s) URL inside `props` is
   * downloaded first and served to the renderer's browser on localhost.
   */
  z.object({
    op: z.literal('render-chunk'),
    props: z.record(z.string(), z.unknown()),
    scale: z.number().positive(),
    frameRange: z.tuple([z.int().nonnegative(), z.int().nonnegative()]),
    encoding: RenderEncodingSchema,
    video: Url,
    audio: Url,
    /** How many chunks run on this service at once; each takes that share of the CPU. */
    share: z.int().positive().default(1),
  }),
  /** Joins chunks (all `framesPerChunk` long but the last) into the MP4 without re-encoding. */
  z.object({
    op: z.literal('combine'),
    videos: z.array(Url).min(1),
    audios: z.array(Url).min(1),
    output: Url,
    fps: z.number().positive(),
    framesPerChunk: z.int().positive(),
    durationInFrames: z.int().positive(),
    encoding: RenderEncodingSchema,
  }),
]);
export type MediaTask = z.infer<typeof MediaTaskSchema>;
export type MediaTaskOp = MediaTask['op'];

export const StartMediaTaskSchema = z.intersection(
  z.object({
    /** Chosen by the caller; a repeat with the same id returns the task already running. */
    id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    /** Where progress and the result are POSTed. */
    callback: Url.optional(),
  }),
  MediaTaskSchema,
);
export type StartMediaTask = z.infer<typeof StartMediaTaskSchema>;

/** What each task returns. */
export const MediaTaskResultSchema = z.object({
  sha256: z.string().optional(),
  shots: z.array(ShotRangeSchema).optional(),
  sizeBytes: z.int().nonnegative().optional(),
  /** Wall time the task took on the service, the unit containers are billed in. */
  seconds: z.number().nonnegative(),
});
export type MediaTaskResult = z.infer<typeof MediaTaskResultSchema>;

/** Error codes the service answers with, so the API can map them to its own. */
export const MEDIA_ERROR_CODES = ['not_a_video', 'invalid_request', 'cancelled', 'failed', 'not_found'] as const;
export const MediaErrorCodeSchema = z.enum(MEDIA_ERROR_CODES);

/** POSTed to a task's callback. */
export const MediaTaskEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), id: z.string(), progress: z.number().min(0).max(1), stage: z.string().optional() }),
  z.object({ type: z.literal('done'), id: z.string(), result: MediaTaskResultSchema }),
  z.object({ type: z.literal('failed'), id: z.string(), error: z.string(), code: MediaErrorCodeSchema }),
]);
export type MediaTaskEvent = z.infer<typeof MediaTaskEventSchema>;

/** GET /v1/tasks/:id. Finished tasks are kept for an hour. */
export const MediaTaskStatusSchema = z.object({
  id: z.string(),
  op: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  progress: z.number().min(0).max(1),
  stage: z.string().optional(),
  result: MediaTaskResultSchema.optional(),
  error: z.string().optional(),
  code: MediaErrorCodeSchema.optional(),
});
export type MediaTaskStatus = z.infer<typeof MediaTaskStatusSchema>;

/**
 * Splits `frames` into `chunks` contiguous, inclusive ranges, all
 * `framesPerChunk` long but the last (what `combineChunks` needs).
 */
export function chunkRanges(frames: number, chunks: number): { framesPerChunk: number; ranges: [number, number][] } {
  const framesPerChunk = Math.ceil(frames / Math.max(1, Math.min(chunks, frames)));
  const ranges: [number, number][] = [];
  for (let from = 0; from < frames; from += framesPerChunk) ranges.push([from, Math.min(frames, from + framesPerChunk) - 1]);
  return { framesPerChunk, ranges };
}
