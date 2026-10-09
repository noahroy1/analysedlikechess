import { buildTimeline } from '@als/composition';
import { defaultTheme } from '@als/theme';
import { describe, expect, it } from 'vitest';
import { adjacentHold, holdStopFrame, reviewStop } from './playback.ts';

// 30 fps; holds at out 60 (90 frames) and out 225 (60 frames). Card-in is 0.25 s = 8 frames.
const timeline = buildTimeline(
  [
    { id: 'a', sourceTime: 2, holdSec: 3 },
    { id: 'b', sourceTime: 4.5, holdSec: 2 },
  ],
  30,
  10,
);

describe('holdStopFrame', () => {
  it('stops once the card has finished animating in', () => {
    expect(timeline.holds.map((h) => holdStopFrame(h, timeline, defaultTheme))).toEqual([68, 233]);
  });
});

describe('reviewStop', () => {
  it('stops at every hold crossed during playback', () => {
    const stops: number[] = [];
    for (let f = 0; f < timeline.outFrames; f++) {
      const stop = reviewStop(f, f + 1, timeline, defaultTheme);
      if (stop !== undefined) stops.push(stop);
    }
    expect(stops).toEqual([68, 233]);
  });

  it('catches a stop skipped over by a dropped frame', () => {
    expect(reviewStop(66, 70, timeline, defaultTheme)).toBe(68);
  });

  it('does not stop again when resuming from the stop frame', () => {
    expect(reviewStop(68, 69, timeline, defaultTheme)).toBeUndefined();
  });

  it('ignores seeks and backwards steps', () => {
    expect(reviewStop(0, 200, timeline, defaultTheme)).toBeUndefined();
    expect(reviewStop(70, 60, timeline, defaultTheme)).toBeUndefined();
  });
});

describe('adjacentHold', () => {
  it('finds the next and previous holds', () => {
    expect(adjacentHold(0, 1, timeline, defaultTheme)?.momentId).toBe('a');
    expect(adjacentHold(68, 1, timeline, defaultTheme)?.momentId).toBe('b');
    expect(adjacentHold(68, -1, timeline, defaultTheme)).toBeUndefined();
    expect(adjacentHold(300, -1, timeline, defaultTheme)?.momentId).toBe('b');
    expect(adjacentHold(233, -1, timeline, defaultTheme)?.momentId).toBe('a');
  });
});
