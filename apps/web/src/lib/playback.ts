import type { Theme } from '@als/schema';
import { cardSettledFrame, type Hold, type Timeline } from '@als/composition';

export type PlaybackMode = 'review' | 'preview';

/** Output frame where Review mode stops for a hold: the first frame with the card fully in. */
export const holdStopFrame = (hold: Hold, timeline: Timeline, theme: Theme) =>
  hold.outStart + cardSettledFrame(hold.frames, timeline.fps, theme.timing);

/**
 * The Review stop crossed by a playback step from `prev` to `next`, if any.
 * Big jumps are seeks, not playback, and never stop.
 */
export function reviewStop(
  prev: number,
  next: number,
  timeline: Timeline,
  theme: Theme,
  maxStep = Math.ceil(timeline.fps / 2),
): number | undefined {
  if (next <= prev || next - prev > maxStep) return undefined;
  for (const hold of timeline.holds) {
    const stop = holdStopFrame(hold, timeline, theme);
    if (prev < stop && stop <= next) return stop;
  }
  return undefined;
}

/** The hold to jump to for N (next) and P (previous) from the current frame. */
export function adjacentHold(frame: number, direction: 1 | -1, timeline: Timeline, theme: Theme): Hold | undefined {
  const stops = timeline.holds.map((hold) => ({ hold, stop: holdStopFrame(hold, timeline, theme) }));
  if (direction === 1) return stops.find((s) => s.stop > frame)?.hold;
  return stops.reverse().find((s) => s.stop < frame)?.hold;
}
