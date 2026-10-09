import type { Shot, Word } from './project.ts';

/** A spoken move freezes this long after its last word. */
export const FREEZE_AFTER_SPEECH_SEC = 0.15;

/** Frames kept clear on each side of a cut: a frozen transition frame looks broken. */
export const CUT_CLEARANCE_FRAMES = 2;

/**
 * Frames [first, last] of the shot containing `sec` that may be frozen: at least
 * CUT_CLEARANCE_FRAMES after the cut that starts it and before the cut that ends it.
 * The clip's own start and end are not cuts.
 */
export function cleanFrameRange(sec: number, shots: readonly Shot[], fps: number): [number, number] | undefined {
  const index = shots.findIndex((s, i) => sec >= s.start && (sec < s.end || i === shots.length - 1));
  const shot = shots[index];
  if (!shot) return undefined;
  const start = Math.round(shot.start * fps);
  const end = Math.round(shot.end * fps); // exclusive
  const first = start + (index > 0 ? CUT_CLEARANCE_FRAMES : 0);
  const last = end - 1 - (index < shots.length - 1 ? CUT_CLEARANCE_FRAMES : 0);
  if (first > last) {
    const middle = Math.floor((start + end - 1) / 2);
    return [middle, middle];
  }
  return [first, last];
}

/**
 * Moves a freeze time onto a frame, keeping it inside the shot that contains
 * `shotOf` (default: the time itself) and clear of that shot's cuts.
 */
export function cleanFreezeTime(sec: number, shots: readonly Shot[], fps: number, shotOf = sec): number {
  const frame = Math.round(sec * fps);
  const range = cleanFrameRange(shotOf, shots, fps);
  if (!range) return frame / fps;
  return Math.min(Math.max(frame, range[0]), range[1]) / fps;
}

/**
 * Where a spoken move freezes: just after its last word, on a clean frame of
 * the shot the line ends in, so the card never lands on the next shot.
 */
export function freezeAfterSpeech(lastWordEnd: number, shots: readonly Shot[], fps: number): number {
  // The word's last frame decides the shot, not the padded time.
  const shotOf = Math.max(0, lastWordEnd - 1 / (2 * fps));
  return cleanFreezeTime(lastWordEnd + FREEZE_AFTER_SPEECH_SEC, shots, fps, shotOf);
}

/** Freeze times right after each word: the editor's snap targets. */
export function speechSnapTargets(words: readonly Word[], shots: readonly Shot[], fps: number): number[] {
  return [...new Set(words.map((w) => freezeAfterSpeech(w.end, shots, fps)))].sort((a, b) => a - b);
}
