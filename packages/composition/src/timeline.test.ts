import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  outDuration,
  sourceFrameToOut,
  sourceToOut,
  timeMap,
  timeMapFrame,
} from './timeline.ts';

const FPS = 30;
const m = (id: string, sourceTime: number, holdSec: number) => ({ id, sourceTime, holdSec });

describe('zero moments', () => {
  const tl = buildTimeline([], FPS, 10);

  it('is the source clip unchanged', () => {
    expect(tl.outFrames).toBe(300);
    expect(tl.holds).toEqual([]);
    expect(tl.segments).toEqual([{ sourceStart: 0, sourceEnd: 300, outStart: 0 }]);
  });

  it('maps every frame to itself', () => {
    for (const f of [0, 1, 150, 299]) {
      expect(timeMapFrame(tl, f)).toEqual({ sourceFrame: f });
      expect(sourceFrameToOut(tl, f)).toBe(f);
    }
  });

  it('matches the seconds API', () => {
    expect(outDuration(10, [], FPS)).toBe(10);
    expect(timeMap(4.5, [], FPS)).toEqual({ sourceSec: 4.5 });
  });
});

describe('one moment', () => {
  // Freeze at 2 s for 3 s: play 0-60, hold 60-150, play source 60-300 from out 150.
  const moments = [m('a', 2, 3)];
  const tl = buildTimeline(moments, FPS, 10);

  it('inserts the hold', () => {
    expect(tl.outFrames).toBe(390);
    expect(tl.holds).toEqual([{ momentId: 'a', index: 0, outStart: 60, frames: 90, sourceFrame: 60 }]);
  });

  it('plays up to the moment, holds its frame, then resumes from it', () => {
    expect(timeMapFrame(tl, 59)).toEqual({ sourceFrame: 59 });
    expect(timeMapFrame(tl, 60)).toEqual({ sourceFrame: 60, hold: { momentId: 'a', index: 0, progress: 0 } });
    expect(timeMapFrame(tl, 105)).toEqual({ sourceFrame: 60, hold: { momentId: 'a', index: 0, progress: 0.5 } });
    expect(timeMapFrame(tl, 149).hold?.progress).toBeCloseTo(89 / 90);
    expect(timeMapFrame(tl, 150)).toEqual({ sourceFrame: 60 });
    expect(timeMapFrame(tl, 151)).toEqual({ sourceFrame: 61 });
    expect(timeMapFrame(tl, 389)).toEqual({ sourceFrame: 299 });
  });

  it('places the moment marker at the start of its hold', () => {
    expect(sourceFrameToOut(tl, 59)).toBe(59);
    expect(sourceFrameToOut(tl, 60)).toBe(60);
    expect(sourceFrameToOut(tl, 61)).toBe(151);
  });

  it('matches the seconds API', () => {
    expect(outDuration(10, moments, FPS)).toBe(13);
    expect(timeMap(3.5, moments, FPS)).toEqual({ sourceSec: 2, hold: { momentId: 'a', progress: 0.5 } });
    expect(timeMap(6, moments, FPS).sourceSec).toBeCloseTo(3);
    expect(sourceToOut(2, moments, FPS)).toBe(2);
    expect(sourceToOut(3, moments, FPS)).toBe(6);
  });
});

describe('a moment at 0 s', () => {
  const tl = buildTimeline([m('a', 0, 2)], FPS, 10);

  it('holds the first frame before anything plays', () => {
    expect(tl.holds[0]).toMatchObject({ outStart: 0, frames: 60, sourceFrame: 0 });
    expect(tl.segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 0, outStart: 0 });
    expect(timeMapFrame(tl, 0)).toEqual({ sourceFrame: 0, hold: { momentId: 'a', index: 0, progress: 0 } });
    expect(timeMapFrame(tl, 60)).toEqual({ sourceFrame: 0 });
    expect(tl.outFrames).toBe(360);
  });
});

describe('a moment on the last frame', () => {
  it('holds the last frame when the moment is on it', () => {
    const tl = buildTimeline([m('a', 299 / FPS, 1)], FPS, 10);
    expect(tl.holds[0]).toMatchObject({ outStart: 299, frames: 30, sourceFrame: 299 });
    expect(timeMapFrame(tl, 298)).toEqual({ sourceFrame: 298 });
    expect(timeMapFrame(tl, 299).hold?.momentId).toBe('a');
    expect(timeMapFrame(tl, 329)).toEqual({ sourceFrame: 299 });
    expect(tl.outFrames).toBe(330);
  });

  it('holds the last real frame when the moment is at the very end', () => {
    const tl = buildTimeline([m('a', 10, 1)], FPS, 10);
    expect(tl.holds[0]).toMatchObject({ outStart: 300, frames: 30, sourceFrame: 299 });
    expect(timeMapFrame(tl, 299)).toEqual({ sourceFrame: 299 });
    expect(timeMapFrame(tl, 300).hold?.momentId).toBe('a');
    expect(tl.outFrames).toBe(330);
  });
});

describe('adjacent moments', () => {
  it('handles moments one frame apart', () => {
    const tl = buildTimeline([m('a', 1, 1), m('b', 1 + 1 / FPS, 1)], FPS, 10);
    expect(tl.holds.map((h) => [h.outStart, h.sourceFrame])).toEqual([
      [30, 30],
      [61, 31],
    ]);
    expect(timeMapFrame(tl, 59).hold?.momentId).toBe('a');
    expect(timeMapFrame(tl, 60)).toEqual({ sourceFrame: 30 });
    expect(timeMapFrame(tl, 61).hold?.momentId).toBe('b');
    expect(timeMapFrame(tl, 91)).toEqual({ sourceFrame: 31 });
  });

  it('keeps moments at the schema minimum gap of 0.5 s apart', () => {
    const tl = buildTimeline([m('a', 2, 3), m('b', 2.5, 3)], FPS, 10);
    expect(tl.holds.map((h) => h.outStart)).toEqual([60, 165]);
    expect(tl.outFrames).toBe(480);
  });

  it('snaps off-grid times and holds to whole frames', () => {
    const tl = buildTimeline([m('a', 1.01, 2.49)], 24, 10);
    expect(tl.holds[0]).toMatchObject({ outStart: 24, frames: 60, sourceFrame: 24 });
  });
});

describe('round trips', () => {
  const moments = [m('a', 0, 2), m('b', 2.5, 3.5), m('c', 7, 4), m('d', 10, 1)];
  const tl = buildTimeline(moments, FPS, 10);

  it('sourceFrameToOut then timeMapFrame returns the same source frame', () => {
    for (let f = 0; f < tl.sourceFrames; f++) {
      expect(timeMapFrame(tl, sourceFrameToOut(tl, f)).sourceFrame).toBe(f);
    }
  });

  it('lands each moment on the first frame of its hold', () => {
    for (const hold of tl.holds.slice(0, 3)) {
      const out = sourceFrameToOut(tl, hold.sourceFrame);
      expect(out).toBe(hold.outStart);
      expect(timeMapFrame(tl, out).hold).toMatchObject({ momentId: hold.momentId, progress: 0 });
    }
  });

  it('covers every output frame exactly once, in order', () => {
    let lastSource = -1;
    let holdFrames = 0;
    for (let out = 0; out < tl.outFrames; out++) {
      const r = timeMapFrame(tl, out);
      if (r.hold) holdFrames++;
      else {
        expect(r.sourceFrame).toBeGreaterThanOrEqual(lastSource);
        lastSource = r.sourceFrame;
      }
    }
    expect(holdFrames).toBe(tl.holds.reduce((sum, h) => sum + h.frames, 0));
    expect(tl.outFrames).toBe(tl.sourceFrames + holdFrames);
  });

  it('seconds round trip', () => {
    for (const sec of [0, 1.3, 2.5, 5, 7, 9.9]) {
      expect(timeMap(sourceToOut(sec, moments, FPS), moments, FPS).sourceSec).toBeCloseTo(sec, 9);
    }
  });
});
