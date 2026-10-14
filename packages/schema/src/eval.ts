import { z } from 'zod';
import type { Classification } from './classification.ts';

// The evaluation bar's values. An eval is White's advantage, as in chess
// engines: pawns (positive when White is ahead) or a forced mate (positive
// when White mates). Each move carries the eval after it; the bar also moves at
// beats, the decision points the Analyst found but did not give a card.

export const EvalSchema = z.union([
  z.object({ pawns: z.number().min(-99).max(99) }).strict(),
  /** Mate in this many moves; positive when White mates. */
  z.object({ mate: z.int().min(-99).max(99).refine((n) => n !== 0, 'mate in 0 is not an eval') }).strict(),
]);
export type Eval = z.infer<typeof EvalSchema>;

export const isMate = (e: Eval): e is { mate: number } => 'mate' in e;

/**
 * Share of the bar that is White's, 0-1. Measured on the creator's bar (Oct 12,
 * 2026): 0.5, 0.8, 1.0, 1.8 and 3.8 pawns fit 0.5 + 0.5 tanh(0.184 pawns)
 * within half a percent, and a mate fills the bar.
 */
export const EVAL_BAR_SLOPE = 0.184;
export function evalFill(e: Eval): number {
  if (isMate(e)) return e.mate > 0 ? 1 : 0;
  return 0.5 + 0.5 * Math.tanh(EVAL_BAR_SLOPE * e.pawns);
}

/** The pawn eval whose bar shows this fill (fill strictly between 0 and 1), to one decimal. */
export function pawnsForFill(fill: number): Eval {
  const f = Math.min(Math.max(fill, 0.001), 0.999);
  return { pawns: round1(Math.atanh(2 * f - 1) / EVAL_BAR_SLOPE) };
}

const round1 = (n: number) => Math.round(n * 10) / 10 || 0;

/** The side the bar leans to; an even position reads from White's end. */
export const evalLeader = (e: Eval): 'white' | 'black' => ((isMate(e) ? e.mate : e.pawns) >= 0 ? 'white' : 'black');

/** The label at the leader's end of the bar: "1.0", "M4". Unsigned, as on the bar. */
export const formatEval = (e: Eval): string => (isMate(e) ? `M${Math.abs(e.mate)}` : Math.abs(e.pawns).toFixed(1));

/** As typed in the editor: "1.0", "-0.8", "M4" (White mates), "-M6" (Black mates). */
export const formatEvalSigned = (e: Eval): string =>
  isMate(e) ? `${e.mate < 0 ? '-' : ''}M${Math.abs(e.mate)}` : `${e.pawns > 0 ? '+' : ''}${e.pawns.toFixed(1)}`;

/** Reads the editor's text: "1", "+2.5", "-0.8", "M4", "#4", "-M6", "-#6". */
export function parseEval(text: string): Eval | undefined {
  const t = text.trim().replace(/\s+/g, '');
  const mate = /^([+-]?)[M#](\d{1,2})$/i.exec(t);
  if (mate) {
    const n = Number(mate[2]);
    return n === 0 ? undefined : { mate: mate[1] === '-' ? -n : n };
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return undefined;
  const pawns = round1(Number(t));
  return Math.abs(pawns) <= 99 ? { pawns } : undefined;
}

export const sameEval = (a: Eval, b: Eval): boolean =>
  isMate(a) ? isMate(b) && a.mate === b.mate : !isMate(b) && a.pawns === b.pawns;

/** A moment the bar reacts to without a card: a decision the Analyst found but did not pick. */
export const EvalBeatSchema = z.object({
  id: z.string().min(1),
  /** When the bar starts to move. */
  sourceTime: z.number().nonnegative(),
  eval: EvalSchema,
  actorId: z.string().min(1).optional(),
  /** What the character did, from Pass A. */
  action: z.string().optional(),
  /** Why the bar moves, from Pass C. */
  reason: z.string().optional(),
  origin: z.enum(['ai', 'user']),
});
export type EvalBeat = z.infer<typeof EvalBeatSchema>;

export const EvalBarSchema = z.object({
  /** The position before the first move. */
  start: EvalSchema,
  /** Sorted by sourceTime. */
  beats: z.array(EvalBeatSchema),
});
export type EvalBar = z.infer<typeof EvalBarSchema>;

export const DEFAULT_START_EVAL: Eval = { pawns: 0.3 };

// How far a beat may move the bar, and how close it may sit to another change,
// depend on the format: `beatMaxSwing` and `beatClearanceSec` in FORMAT_RULES.

/**
 * Which way a rating moves the bar for the player who made it. The bar tells
 * the story, so good moves gain ground and bad ones lose it; a sound move
 * (good, book) may go either way. TODO(open-decision): sizes per rating are
 * only guidance to the Analyst (Pass C's prompt gives typical sizes measured
 * on the user's short-form benchmark, Oct 15, 2026); the creator's own swings
 * do not scale with the rating (their brilliant moved the bar less than their
 * great), so nothing here enforces a size.
 */
export const EVAL_DIRECTION: Record<Classification, 'gain' | 'loss' | 'either'> = {
  brilliant: 'gain',
  great: 'gain',
  best: 'gain',
  excellent: 'gain',
  good: 'either',
  book: 'either',
  inaccuracy: 'loss',
  mistake: 'loss',
  miss: 'loss',
  blunder: 'loss',
};

/** Fill changes this small count as holding steady, in either direction. */
export const EVAL_HOLD_TOLERANCE = 0.01;

/** The bar's change for the mover: positive when it gains them ground. */
export const swingFor = (side: 'white' | 'black', before: Eval, after: Eval): number =>
  (side === 'white' ? 1 : -1) * (evalFill(after) - evalFill(before));

/** Whether an eval change fits the rating, given who moved. */
export function swingFits(classification: Classification, side: 'white' | 'black', before: Eval, after: Eval): boolean {
  const swing = swingFor(side, before, after);
  const direction = EVAL_DIRECTION[classification];
  if (direction === 'gain') return swing >= -EVAL_HOLD_TOLERANCE;
  if (direction === 'loss') return swing <= EVAL_HOLD_TOLERANCE;
  return true;
}

/** Caps a beat's change at `maxSwing` of the bar (the format's `beatMaxSwing`), keeping its direction. */
export function capBeat(before: Eval, after: Eval, maxSwing: number): Eval {
  const from = evalFill(before);
  const delta = evalFill(after) - from;
  if (Math.abs(delta) <= maxSwing) return after;
  const capped = from + Math.sign(delta) * maxSwing;
  return capped >= 1 || capped <= 0 ? after : pawnsForFill(capped);
}
