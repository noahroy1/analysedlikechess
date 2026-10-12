import { describe, expect, it } from 'vitest';
import { detectCuts, parseScdet, shotsFromCuts, type FrameScore } from './cuts.ts';

/** Frames at 24 fps with a low background score and the given spikes. */
const frames = (spikes: Record<string, number>, seconds = 4): FrameScore[] =>
  Array.from({ length: seconds * 24 }, (_, i) => {
    const time = Number((i / 24).toFixed(3));
    return { time, score: spikes[time.toFixed(3)] ?? 0.4 };
  });

describe('parseScdet', () => {
  it('reads time and score pairs from metadata=print output', () => {
    const output = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.scd.mafd=0.000',
      'lavfi.scd.score=0.000',
      'out_time_us=0',
      'frame:1    pts:256     pts_time:0.0166667',
      'lavfi.scd.mafd=7.100',
      'lavfi.scd.score=7.102',
    ].join('\n');
    expect(parseScdet(output)).toEqual([
      { time: 0, score: 0 },
      { time: 0.0166667, score: 7.102 },
    ]);
  });
});

describe('detectCuts', () => {
  it('finds isolated spikes that dark footage keeps below a fixed threshold', () => {
    expect(detectCuts(frames({ '1.000': 5.4, '2.500': 7.1 }))).toEqual([1, 2.5]);
  });

  it('ignores sustained motion that ramps through the same scores', () => {
    const motion: Record<string, number> = {};
    for (let i = 24; i < 48; i++) motion[(i / 24).toFixed(3)] = 3 + (i % 5) * 0.5;
    expect(detectCuts(frames(motion))).toEqual([]);
  });

  it('always keeps huge jumps, even inside motion', () => {
    expect(detectCuts(frames({ '1.000': 6, '1.042': 24, '1.083': 6 }))).toEqual([1.042]);
  });

  it('keeps only the stronger of two cuts closer than the minimum shot', () => {
    expect(detectCuts(frames({ '1.000': 12, '1.125': 18 }))).toEqual([1.125]);
  });

  it('never cuts at time zero', () => {
    expect(detectCuts(frames({ '0.000': 50 }))).toEqual([]);
  });
});

describe('shotsFromCuts', () => {
  it('splits the clip at each cut', () => {
    expect(shotsFromCuts([3.5, 7], 10)).toEqual([
      { start: 0, end: 3.5 },
      { start: 3.5, end: 7 },
      { start: 7, end: 10 },
    ]);
  });

  it('is one shot when there are no cuts', () => {
    expect(shotsFromCuts([], 10)).toEqual([{ start: 0, end: 10 }]);
  });

  it('drops cuts too close to either end', () => {
    expect(shotsFromCuts([0.1, 5, 9.9], 10)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ]);
  });
});
