import { z } from 'zod';
import type { Classification } from './classification.ts';
import { DEFAULT_START_EVAL, evalFill, isMate, type Eval, type EvalBar } from './eval.ts';
import { evalKeyframes } from './eval-track.ts';
import type { Character, Moment } from './project.ts';
import type { Theme } from './theme.ts';

// The game review that closes an episode: chess.com's Game Review screen
// (media/game-review-screen-ref.png, Oct 15, 2026) with the cast in place of
// the players. It shows once game-end has played, after the clip's last frame:
// the result in a speech bubble, the bar's travel as a graph with every move
// dotted in its rating's colour, each side's accuracy, and how many moves of
// each rating each side made.

type Side = 'white' | 'black';

/** Accuracy shown until we compute one (the user's choice, Oct 15, 2026); editable per side. */
export const DEFAULT_ACCURACY = 70;

const AccuracySchema = z.number().min(0).max(100);

export const GameReviewSchema = z.object({
  /** Each side's accuracy as typed; absent shows DEFAULT_ACCURACY. */
  accuracy: z.object({ white: AccuracySchema.optional(), black: AccuracySchema.optional() }).optional(),
  /** The line in the speech bubble; absent is written from the result (`reviewSummary`). */
  summary: z.string().min(1).max(160).optional(),
});
export type GameReview = z.infer<typeof GameReviewSchema>;

export const reviewAccuracy = (review: GameReview | undefined, side: Side): number => review?.accuracy?.[side] ?? DEFAULT_ACCURACY;

/** Seconds the review stays up; 0 for a look without one. */
export const gameReviewSec = (theme: Pick<Theme, 'gameReview'>): number => theme.gameReview?.holdSec ?? 0;

/** The tally's rows, in chess.com's order (Book sits between Great and Best). */
export const REVIEW_ROWS: readonly Classification[] = [
  'brilliant',
  'great',
  'book',
  'best',
  'excellent',
  'good',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
];

export type MoveTally = Record<Side, Record<Classification, number>>;

/** How many moves of each rating each side made. A move by nobody, or by someone with no side, is not counted. */
export function moveTallies(
  moments: readonly Pick<Moment, 'actorId' | 'classification'>[],
  characters: readonly Pick<Character, 'id' | 'side'>[],
): MoveTally {
  const empty = () => Object.fromEntries(REVIEW_ROWS.map((c) => [c, 0])) as Record<Classification, number>;
  const tally: MoveTally = { white: empty(), black: empty() };
  const sides = new Map(characters.map((c) => [c.id, c.side]));
  for (const m of moments) {
    const side = m.actorId ? sides.get(m.actorId) : undefined;
    if (side) tally[side][m.classification] += 1;
  }
  return tally;
}

/** A bar this close to level at the end (about half a pawn) is a draw. */
export const DRAW_FILL = 0.05;
/** A side this far behind on the bar (about 1.7 pawns) was losing. */
export const LOSING_FILL = 0.15;

export interface GameResult {
  start: Eval;
  /** The bar's last value: the last move's or beat's eval. */
  end: Eval;
  /** White's lowest and highest share of the bar along the way, the start included. */
  range: { min: number; max: number };
  /** Absent on a draw. */
  winner?: Side;
}

/** Who won: whoever the bar favours at the end. */
export function gameResult(
  evalBar: EvalBar | undefined,
  moments: readonly Pick<Moment, 'id' | 'sourceTime' | 'eval' | 'actorId' | 'classification'>[],
  characters: readonly Pick<Character, 'id' | 'side'>[],
): GameResult {
  const start = evalBar?.start ?? DEFAULT_START_EVAL;
  const evals = [start, ...evalKeyframes(evalBar, moments, characters).map((k) => k.eval)];
  const end = evals.at(-1)!;
  const fills = evals.map(evalFill);
  const range = { min: Math.min(...fills), max: Math.max(...fills) };
  const lean = evalFill(end) - 0.5;
  return { start, end, range, ...(Math.abs(lean) > DRAW_FILL ? { winner: lean > 0 ? ('white' as const) : ('black' as const) } : {}) };
}

/**
 * The speech bubble's line when none was typed, in chess.com's voice ("You won
 * with a nice midgame mating tactic, turning an even game into victory!") with
 * the winner's name: a comeback if the winner was losing along the way, else
 * from where they started. TODO(open-decision): the Analyst could write this
 * line from the scene; until then it is built from the bar.
 */
export function reviewSummary(result: GameResult, names: Partial<Record<Side, string>>): string {
  const { winner } = result;
  if (!winner) return 'The game ended in a draw.';
  const name = names[winner] || (winner === 'white' ? 'White' : 'Black');
  const how = isMate(result.end) ? ' with a mating attack' : '';
  // The winner's share of the bar before the first move, and at its lowest.
  const lean = (fill: number) => (winner === 'white' ? fill - 0.5 : 0.5 - fill);
  const startLean = lean(evalFill(result.start));
  const worstLean = winner === 'white' ? lean(result.range.min) : lean(result.range.max);
  const story =
    worstLean < -LOSING_FILL || startLean < -DRAW_FILL
      ? 'turning a lost game into victory!'
      : startLean > DRAW_FILL
        ? 'converting an early advantage into victory!'
        : 'turning an even game into victory!';
  return `${name} won${how}, ${story}`;
}

export interface GraphPoint {
  /** White's share of the bar, 0-1. */
  fill: number;
  /** Set on a move, which the graph dots in its rating's colour. */
  classification?: Classification;
}

/**
 * The bar's travel for the review graph: the start, then one point per change
 * (move or beat), evenly spaced like chess.com's plies. A move with no eval
 * keeps the bar where it was but still gets its dot.
 */
export function evalGraph(
  evalBar: EvalBar | undefined,
  moments: readonly Pick<Moment, 'id' | 'sourceTime' | 'eval' | 'actorId' | 'classification'>[],
  characters: readonly Pick<Character, 'id' | 'side'>[],
): GraphPoint[] {
  const changes = [
    ...evalKeyframes(evalBar, moments, characters).map((k) => ({ sourceTime: k.sourceTime, eval: k.eval as Eval | undefined, classification: k.classification })),
    ...moments.filter((m) => !m.eval).map((m) => ({ sourceTime: m.sourceTime, eval: undefined, classification: m.classification })),
  ].sort((a, b) => a.sourceTime - b.sourceTime);
  let fill = evalFill(evalBar?.start ?? DEFAULT_START_EVAL);
  return [
    { fill },
    ...changes.map((c) => {
      if (c.eval) fill = evalFill(c.eval);
      return { fill, ...(c.classification ? { classification: c.classification } : {}) };
    }),
  ];
}
