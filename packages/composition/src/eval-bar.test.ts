import { evalFill, type Eval, type EvalKeyframe } from '@als/schema';
import { describe, expect, it } from 'vitest';
import { CARD_READING_SEC, evalBarAt, placeKeyframes, settleReadings } from './eval-bar.ts';
import { buildTimeline } from './timeline.ts';

describe('settleReadings', () => {
  it('steps through more readings for bigger swings, ending on the new eval', () => {
    // The creator's own: an inaccuracy in two readings, a brilliant in three, a great in four.
    const inaccuracy = settleReadings({ pawns: 1 }, { pawns: 0.4 }, 'move', 'm1');
    const brilliant = settleReadings({ pawns: 0.5 }, { pawns: -1 }, 'move', 'm2');
    const great = settleReadings({ mate: 7 }, { pawns: 1 }, 'move', 'm3');
    expect(inaccuracy).toHaveLength(2);
    expect(brilliant).toHaveLength(3);
    expect(great).toHaveLength(4);
    for (const [r, end] of [[inaccuracy, 0.4], [brilliant, -1], [great, 1]] as [Eval[], number][]) {
      expect(r.at(-1)).toEqual({ pawns: end });
    }
  });

  it('approaches from the old eval, as an engine searching deeper', () => {
    const great = settleReadings({ mate: 7 }, { pawns: 1 }, 'move', 'm3').map(evalFill);
    expect(great[0]).toBeLessThan(1);
    expect(great[0]).toBeGreaterThan(great[1]!);
  });

  it('wobbles the count when a mate holds', () => {
    const r = settleReadings({ mate: 4 }, { mate: 6 }, 'move', 'm4');
    expect(r.at(-1)).toEqual({ mate: 6 });
    expect(r.every((e) => 'mate' in e && e.mate >= 6)).toBe(true);
  });

  it('settles a beat in one or two readings', () => {
    expect(settleReadings({ pawns: 0.3 }, { pawns: 0.35 }, 'beat', 'b1')).toEqual([{ pawns: 0.35 }]);
    expect(settleReadings({ pawns: 0.3 }, { pawns: 0.9 }, 'beat', 'b2')).toHaveLength(2);
  });

  it('is the same every time for the same id', () => {
    expect(settleReadings({ pawns: 0.5 }, { pawns: -1 }, 'move', 'x')).toEqual(settleReadings({ pawns: 0.5 }, { pawns: -1 }, 'move', 'x'));
  });
});

describe('evalBarAt', () => {
  const fps = 30;
  const moments = [{ id: 'm1', sourceTime: 2, holdSec: 5 }];
  const timeline = buildTimeline(moments, fps, 20);
  const keyframes: EvalKeyframe[] = [
    { id: 'b1', kind: 'beat', sourceTime: 1, eval: { pawns: 0.6 }, before: { pawns: 0.3 } },
    { id: 'm1', kind: 'move', sourceTime: 2, eval: { mate: 3 }, before: { pawns: 0.6 } },
    { id: 'b2', kind: 'beat', sourceTime: 4, eval: { mate: 2 }, before: { mate: 3 } },
  ];
  const placed = placeKeyframes(keyframes, timeline);
  const at = (frame: number) => evalBarAt({ pawns: 0.3 }, placed, frame, fps);

  it('places moves at their hold and beats where their frame plays', () => {
    expect(placed.map((k) => k.outFrame)).toEqual([30, 60, 4 * fps + 5 * fps]);
  });

  it('shows the start before anything happens', () => {
    expect(at(0)).toEqual({ label: { pawns: 0.3 }, fill: evalFill({ pawns: 0.3 }) });
  });

  it('holds the old value until the first reading, then eases the bar after the label', () => {
    const hold = 60;
    expect(at(hold + 2).label).toEqual({ pawns: 0.6 });
    const first = hold + Math.ceil(CARD_READING_SEC[0] * fps);
    const reading = placed[1]!.readings[0]!;
    expect(at(first).label).toEqual(reading);
    expect(at(first).fill).toBeCloseTo(evalFill({ pawns: 0.6 }), 2);
    expect(at(hold + 4 * fps).label).toEqual({ mate: 3 });
    expect(at(hold + 4 * fps).fill).toBeCloseTo(1, 5);
  });
});
