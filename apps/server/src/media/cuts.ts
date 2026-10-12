import type { Shot } from '@als/schema';

export interface FrameScore {
  time: number;
  score: number;
}

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

/** Parses `metadata=print` output from ffmpeg's scdet filter into per-frame scores. */
export function parseScdet(output: string): FrameScore[] {
  const frames: FrameScore[] = [];
  let time: number | undefined;
  for (const line of output.split('\n')) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) {
      time = Number(pts[1]);
      continue;
    }
    const score = /lavfi\.scd\.score=([\d.]+)/.exec(line);
    if (score && time !== undefined) {
      frames.push({ time, score: Number(score[1]) });
      time = undefined;
    }
  }
  return frames;
}

/** Times of the first frame of each new shot. */
export function detectCuts(frames: FrameScore[], settings = CUT_DETECTION): number[] {
  const cuts: FrameScore[] = [];
  frames.forEach((frame, i) => {
    if (frame.time <= 0 || frame.score < settings.minScore) return;
    let neighbour = 0;
    for (let j = i - 1; j >= 0 && frame.time - frames[j]!.time <= settings.windowSec; j--) {
      neighbour = Math.max(neighbour, frames[j]!.score);
    }
    for (let j = i + 1; j < frames.length && frames[j]!.time - frame.time <= settings.windowSec; j++) {
      neighbour = Math.max(neighbour, frames[j]!.score);
    }
    if (frame.score < settings.hardScore && frame.score < settings.peakRatio * neighbour) return;

    const last = cuts.at(-1);
    if (last && frame.time - last.time < settings.minShotSec) {
      if (frame.score > last.score) cuts[cuts.length - 1] = frame;
    } else {
      cuts.push(frame);
    }
  });
  return cuts.map((c) => c.time);
}

/** Splits [0, duration] into shots at each cut, dropping cuts too close to the ends. */
export function shotsFromCuts(cuts: number[], durationSec: number, minShotSec = CUT_DETECTION.minShotSec): Shot[] {
  const bounds = [0, ...cuts.filter((t) => t >= minShotSec && t <= durationSec - minShotSec), durationSec];
  return bounds.slice(1).map((end, i) => ({ start: bounds[i]!, end }));
}
