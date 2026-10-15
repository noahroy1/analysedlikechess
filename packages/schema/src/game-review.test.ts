import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCURACY, REVIEW_ROWS, evalGraph, gameResult, gameReviewSec, moveTallies, reviewAccuracy, reviewSummary } from './game-review.ts';
import { evalFill, type EvalBar } from './eval.ts';
import type { Character, Moment } from './project.ts';

const cast: Pick<Character, 'id' | 'side'>[] = [
  { id: 'walt', side: 'white' },
  { id: 'jesse', side: 'white' },
  { id: 'hank', side: 'black' },
  { id: 'extra' },
];
type M = Pick<Moment, 'id' | 'sourceTime' | 'eval' | 'actorId' | 'classification'>;
const move = (id: string, sourceTime: number, actorId: string | undefined, classification: Moment['classification'], evalAfter?: Moment['eval']): M => ({
  id,
  sourceTime,
  classification,
  ...(actorId ? { actorId } : {}),
  ...(evalAfter ? { eval: evalAfter } : {}),
});

describe('moveTallies', () => {
  it('counts each side’s moves by rating, allies together, skipping moves nobody on a side made', () => {
    const tally = moveTallies(
      [move('a', 1, 'walt', 'best'), move('b', 2, 'jesse', 'best'), move('c', 3, 'hank', 'blunder'), move('d', 4, 'extra', 'great'), move('e', 5, undefined, 'good')],
      cast,
    );
    expect(tally.white.best).toBe(2);
    expect(tally.black.blunder).toBe(1);
    expect(Object.values(tally.white).reduce((a, b) => a + b, 0)).toBe(2);
    expect(Object.values(tally.black).reduce((a, b) => a + b, 0)).toBe(1);
    expect(Object.keys(tally.white)).toEqual([...REVIEW_ROWS]);
  });
});

describe('gameResult and reviewSummary', () => {
  const bar = (start: EvalBar['start']): EvalBar => ({ start, beats: [] });

  it('ends where the last move or beat leaves the bar', () => {
    const evalBar: EvalBar = { start: { pawns: 0.3 }, beats: [{ id: 'b1', sourceTime: 9, eval: { pawns: -2 }, origin: 'ai' }] };
    const result = gameResult(evalBar, [move('a', 5, 'walt', 'great', { pawns: 3 })], cast);
    expect(result.end).toEqual({ pawns: -2 });
    expect(result.winner).toBe('black');
  });

  it('calls a level ending a draw', () => {
    const result = gameResult(bar({ pawns: 0.3 }), [move('a', 5, 'walt', 'good', { pawns: 0 })], cast);
    expect(result.winner).toBeUndefined();
    expect(reviewSummary(result, { white: 'Walter White', black: 'Hank Schrader' })).toBe('The game ended in a draw.');
  });

  it('writes the line in chess.com’s voice, from where the winner started', () => {
    const names = { white: 'Walter White', black: 'Hank Schrader' };
    const even = gameResult(bar({ pawns: 0.3 }), [move('a', 5, 'walt', 'brilliant', { mate: 3 })], cast);
    expect(reviewSummary(even, names)).toBe('Walter White won with a mating attack, turning an even game into victory!');
    const comeback = gameResult(bar({ pawns: 2 }), [move('a', 5, 'hank', 'great', { pawns: -4 })], cast);
    expect(reviewSummary(comeback, names)).toBe('Hank Schrader won, turning a lost game into victory!');
    const ahead = gameResult(bar({ pawns: -2 }), [move('a', 5, 'hank', 'best', { pawns: -4 })], cast);
    expect(reviewSummary(ahead, {})).toBe('Black won, converting an early advantage into victory!');
    // Ahead at the start, then well behind, then winning: a comeback.
    const swing = gameResult(bar({ pawns: -1.5 }), [move('a', 5, 'walt', 'great', { pawns: 6.1 }), move('b', 9, 'hank', 'brilliant', { mate: -4 })], cast);
    expect(swing.range).toEqual({ min: 0, max: evalFill({ pawns: 6.1 }) });
    expect(reviewSummary(swing, names)).toBe('Hank Schrader won with a mating attack, turning a lost game into victory!');
  });
});

describe('evalGraph', () => {
  it('plots the start, then every move and beat in order, dotting the moves', () => {
    const evalBar: EvalBar = { start: { pawns: 0 }, beats: [{ id: 'b1', sourceTime: 3, eval: { pawns: 1 }, origin: 'ai' }] };
    const points = evalGraph(evalBar, [move('a', 5, 'hank', 'mistake', { pawns: 2 }), move('c', 8, 'walt', 'good')], cast);
    expect(points).toEqual([
      { fill: 0.5 },
      { fill: evalFill({ pawns: 1 }) },
      { fill: evalFill({ pawns: 2 }), classification: 'mistake' },
      // No eval: the bar holds, but the move still gets its dot.
      { fill: evalFill({ pawns: 2 }), classification: 'good' },
    ]);
  });
});

it('falls back to the default accuracy and to no review without a theme block', () => {
  expect(reviewAccuracy(undefined, 'white')).toBe(DEFAULT_ACCURACY);
  expect(reviewAccuracy({ accuracy: { black: 61.6 } }, 'black')).toBe(61.6);
  expect(gameReviewSec({})).toBe(0);
  expect(gameReviewSec({ gameReview: { holdSec: 5, backdropDim: 0.6 } })).toBe(5);
});
