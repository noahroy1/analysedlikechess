import { describe, expect, it } from 'vitest';
import { snapTime } from './snapping.ts';

const ctx = {
  targets: [2, 5.2, 8.4],
  shots: [
    { start: 0, end: 3.5 },
    { start: 3.5, end: 7 },
    { start: 7, end: 10 },
  ],
  fps: 30,
};

describe('snapTime', () => {
  it('snaps to the end of nearby speech', () => {
    expect(snapTime(2.1, ctx, true, 0.2)).toEqual({ sec: 2, kind: 'speech' });
  });

  it('otherwise lands on a frame clear of cuts', () => {
    expect(snapTime(3.49, ctx, true, 0.2)).toEqual({ sec: 102 / 30, kind: 'clean' });
  });

  it('with snapping off lands on the nearest frame, even beside a cut', () => {
    expect(snapTime(2.1, ctx, false, 0.2)).toEqual({ sec: 63 / 30, kind: 'free' });
    expect(snapTime(3.49, ctx, false, 0.2)).toEqual({ sec: 105 / 30, kind: 'free' });
  });
});
