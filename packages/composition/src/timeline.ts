import type { Moment } from '@als/schema';

// The output video is the source clip with a hold inserted at every moment:
//   play [0, t1] · hold t1 for h1 · play [t1, t2] · hold t2 for h2 · … · play [tn, end]
// Everything here works in frames, with moment times and hold lengths snapped
// to the frame grid, so the Player, the timeline UI and the renderer agree to the frame.

type TimedMoment = Pick<Moment, 'id' | 'sourceTime' | 'holdSec'>;

export interface Hold {
  momentId: string;
  /** Index into the sorted moments. */
  index: number;
  /** Output frame the hold starts on. */
  outStart: number;
  /** Hold length in output frames, at least 1. */
  frames: number;
  /** Source frame shown for the whole hold. */
  sourceFrame: number;
}

/** Plays source frames [sourceStart, sourceEnd) from `outStart`, then its hold, if any. */
export interface Segment {
  sourceStart: number;
  sourceEnd: number;
  outStart: number;
  hold?: Hold;
}

export interface Timeline {
  fps: number;
  sourceFrames: number;
  outFrames: number;
  segments: Segment[];
  holds: Hold[];
}

export interface TimeMapResult {
  /** Source frame (fractional between frames) shown at this output time. */
  sourceFrame: number;
  hold?: { momentId: string; index: number; progress: number };
}

/**
 * Builds the play/hold segments. Moments must be sorted by `sourceTime`
 * (the schema enforces it). With `durationSec` omitted the clip is treated as unbounded.
 */
export function buildTimeline(moments: readonly TimedMoment[], fps: number, durationSec = Infinity): Timeline {
  const sourceFrames = Number.isFinite(durationSec) ? Math.max(1, Math.round(durationSec * fps)) : Infinity;
  const segments: Segment[] = [];
  const holds: Hold[] = [];
  let sourceStart = 0;
  let outStart = 0;

  moments.forEach((moment, index) => {
    const boundary = Math.min(Math.max(Math.round(moment.sourceTime * fps), sourceStart), sourceFrames);
    const frames = Math.max(1, Math.round(moment.holdSec * fps));
    const holdOut = outStart + (boundary - sourceStart);
    const hold: Hold = {
      momentId: moment.id,
      index,
      outStart: holdOut,
      frames,
      // A moment at the very end freezes on the last real frame.
      sourceFrame: Math.min(boundary, sourceFrames - 1),
    };
    segments.push({ sourceStart, sourceEnd: boundary, outStart, hold });
    holds.push(hold);
    sourceStart = boundary;
    outStart = holdOut + frames;
  });

  segments.push({ sourceStart, sourceEnd: sourceFrames, outStart });
  const outFrames = outStart + (sourceFrames - sourceStart);
  return { fps, sourceFrames, outFrames, segments, holds };
}

/** What the output shows at an output frame (fractional frames allowed). */
export function timeMapFrame(timeline: Timeline, outFrame: number): TimeMapResult {
  const out = Math.max(0, outFrame);
  for (const segment of timeline.segments) {
    const playEnd = segment.outStart + (segment.sourceEnd - segment.sourceStart);
    if (out < playEnd) return { sourceFrame: segment.sourceStart + (out - segment.outStart) };
    const { hold } = segment;
    if (hold && out < hold.outStart + hold.frames) {
      return {
        sourceFrame: hold.sourceFrame,
        hold: { momentId: hold.momentId, index: hold.index, progress: (out - hold.outStart) / hold.frames },
      };
    }
  }
  // Past the end: the last frame.
  const last = timeline.segments.at(-1)!;
  return { sourceFrame: Math.max(last.sourceStart, last.sourceEnd - 1) };
}

/**
 * Output frame where a source frame first appears. For a moment's own frame
 * that is the start of its hold, which is where markers and seeks should land.
 */
export function sourceFrameToOut(timeline: Timeline, sourceFrame: number): number {
  let held = 0;
  for (const hold of timeline.holds) {
    const boundary = timeline.segments[hold.index]!.sourceEnd;
    if (boundary >= sourceFrame) break;
    held += hold.frames;
  }
  return sourceFrame + held;
}

// Seconds API, as used by the plan and by callers that think in time.

export function timeMap(
  outSec: number,
  moments: readonly TimedMoment[],
  fps: number,
): { sourceSec: number; hold?: { momentId: string; progress: number } } {
  const result = timeMapFrame(buildTimeline(moments, fps), outSec * fps);
  return {
    sourceSec: result.sourceFrame / fps,
    ...(result.hold ? { hold: { momentId: result.hold.momentId, progress: result.hold.progress } } : {}),
  };
}

export function sourceToOut(sourceSec: number, moments: readonly TimedMoment[], fps: number): number {
  return sourceFrameToOut(buildTimeline(moments, fps), sourceSec * fps) / fps;
}

export function outDuration(sourceDurationSec: number, moments: readonly TimedMoment[], fps: number): number {
  return buildTimeline(moments, fps, sourceDurationSec).outFrames / fps;
}
