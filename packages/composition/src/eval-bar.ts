import { evalFill, isMate, pawnsForFill, type Eval, type EvalKeyframe } from '@als/schema';
import { sourceFrameToOut, type Timeline } from './timeline.ts';

// The evaluation bar's motion. A new eval does not slide straight in: like an
// engine searching deeper, the label steps through a few readings and the bar
// eases to each in turn. Measured on the creator's videos (Oct 12, 2026):
//   great       M7 → 3.8 → 1.8 → 0.8 → 1.0
//   brilliant   0.5 → 0.1 → -0.8 → -1.0
//   inaccuracy  1.0 → 0.8 → 0.4
//   (holding)   M4 → M7 → M6
// Readings land 0.18, 0.58, 1.13 and 1.78 s into the freeze; each time the
// label changes first, then the bar eases over about a third of a second.
// Bigger swings take more readings. Beats, during play, settle in one or two.

/** Seconds after the keyframe when each reading shows, for a card and for a beat. */
export const CARD_READING_SEC = [0.18, 0.58, 1.13, 1.78] as const;
export const BEAT_READING_SEC = [0, 0.45] as const;
const EASE_DELAY_SEC = 0.05;
const EASE_SEC = 0.33;

/** Each intermediate reading's share of the way from the old fill to the new, by reading count. */
const APPROACH: Record<number, readonly number[]> = {
  2: [0.3],
  3: [0.28, 0.87],
  4: [0.48, 0.83, 1.04],
};

/** The readings a keyframe steps through, ending on its eval. Seeded by its id, so every render agrees. */
export function settleReadings(before: Eval, after: Eval, kind: EvalKeyframe['kind'], seed: string): Eval[] {
  const from = evalFill(before);
  const to = evalFill(after);
  const swing = Math.abs(to - from);
  const random = mulberry32(hash(seed));
  const count = kind === 'beat' ? (swing < 0.02 ? 1 : 2) : swing < 0.1 ? 2 : swing < 0.25 ? 3 : 4;
  if (count === 1) return [after];

  // Holding a mate: the count wobbles, as M4 → M7 → M6.
  if (isMate(before) && isMate(after) && Math.sign(before.mate) === Math.sign(after.mate)) {
    const sign = Math.sign(after.mate);
    return Array.from({ length: count }, (_, i) => {
      const extra = count - 1 - i + (i === 0 && random() < 0.5 ? 1 : 0);
      return { mate: after.mate + sign * extra };
    });
  }

  const shares = kind === 'beat' ? [0.6] : APPROACH[count]!;
  // Intermediate readings stay short of a full bar (about ±10.6 pawns), so
  // settling into a mate reads as a big number, then the mate.
  const readings: Eval[] = shares.map((share) => {
    const jitter = (random() - 0.5) * 0.12;
    return pawnsForFill(Math.min(0.98, Math.max(0.02, from + (to - from) * (share + jitter))));
  });
  // A card that barely moves the bar still shows the engine thinking.
  if (kind === 'move' && swing < 0.01 && !isMate(after)) {
    const wobble = (random() < 0.5 ? -1 : 1) * (0.2 + Math.round(random() * 2) / 10);
    readings[0] = { pawns: Math.round((after.pawns + wobble) * 10) / 10 || 0 };
  }
  return [...readings, after];
}

/** A keyframe placed on the output timeline, with its readings worked out. */
export interface PlacedKeyframe extends EvalKeyframe {
  outFrame: number;
  readings: Eval[];
  readingSec: readonly number[];
}

/** Puts each change of the bar on the output: a move at the start of its hold, a beat where its source frame plays. */
export function placeKeyframes(keyframes: readonly EvalKeyframe[], timeline: Timeline): PlacedKeyframe[] {
  const holds = new Map(timeline.holds.map((h) => [h.momentId, h]));
  return keyframes.flatMap((k) => {
    const hold = k.kind === 'move' ? holds.get(k.id) : undefined;
    if (k.kind === 'move' && !hold) return [];
    const outFrame = hold ? hold.outStart : sourceFrameToOut(timeline, Math.round(k.sourceTime * timeline.fps));
    const readings = settleReadings(k.before, k.eval, k.kind, k.id);
    return [{ ...k, outFrame, readings, readingSec: k.kind === 'beat' ? BEAT_READING_SEC : CARD_READING_SEC }];
  });
}

export interface EvalBarState {
  /** The label's reading. */
  label: Eval;
  /** 0-1 share of the bar that is White's. */
  fill: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/** What the bar shows at an output frame. */
export function evalBarAt(start: Eval, placed: readonly PlacedKeyframe[], outFrame: number, fps: number): EvalBarState {
  let current: PlacedKeyframe | undefined;
  for (const k of placed) {
    if (k.outFrame > outFrame) break;
    current = k;
  }
  if (!current) return { label: start, fill: evalFill(start) };

  const t = (outFrame - current.outFrame) / fps;
  let label = current.before;
  let fill = evalFill(current.before);
  current.readings.forEach((reading, i) => {
    const at = current.readingSec[i] ?? current.readingSec.at(-1)!;
    if (t < at) return;
    const eased = easeInOutCubic(clamp01((t - at - EASE_DELAY_SEC) / EASE_SEC));
    label = reading;
    fill += (evalFill(reading) - fill) * eased;
  });
  return { label, fill };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
