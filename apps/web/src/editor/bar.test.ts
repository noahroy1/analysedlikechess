import { describe, expect, it } from 'vitest';
import type { Moment } from '@als/schema';
import { addBeat, applyEvaluation, deleteBeat, deleteCharacter, evalBefore, hasItem, setMomentEval, updateBeat, type Doc } from './doc.ts';

const moment = (id: string, sourceTime: number, extra: Partial<Moment> = {}): Moment => ({
  id,
  sourceTime,
  holdSec: 8,
  classification: 'good',
  moveLabel: id,
  explanation: '',
  card: { anchor: 'top-right', scale: 1 },
  evidence: { utteranceIds: [] },
  origin: 'ai',
  status: 'draft',
  ...extra,
});

const doc: Doc = {
  moments: [moment('m1', 5, { eval: { pawns: 1 } }), moment('m2', 20, { eval: { mate: 3 } })],
  characters: [{ id: 'w', name: 'Walt', speakerLabels: [], side: 'white' }],
  themeId: 'creator',
  evalBar: { start: { pawns: 0.2 }, beats: [{ id: 'k1', sourceTime: 10, eval: { pawns: 1.4 }, actorId: 'w', origin: 'ai' }] },
};

describe('the bar in the editor', () => {
  it('reads the bar just before a time, from the start, moves and beats', () => {
    expect(evalBefore(doc, 1)).toEqual({ pawns: 0.2 });
    expect(evalBefore(doc, 12)).toEqual({ pawns: 1.4 });
    expect(evalBefore(doc, 25)).toEqual({ mate: 3 });
  });

  it('adds a beat holding the current value, so the bar does not jump', () => {
    const { doc: next, id } = addBeat(doc, { sourceTime: 15 }, 30);
    expect(next.evalBar!.beats.find((b) => b.id === id)).toMatchObject({ sourceTime: 15, eval: { pawns: 1.4 }, origin: 'user' });
    expect(hasItem(next, id)).toBe(true);
    expect(hasItem(deleteBeat(next, id), id)).toBe(false);
  });

  it('starts a bar on a project without one', () => {
    const { doc: next } = addBeat({ ...doc, evalBar: undefined }, { sourceTime: 2 }, 30);
    expect(next.evalBar?.start).toBeDefined();
    expect(next.evalBar?.beats).toHaveLength(1);
  });

  it('edits a beat inside the clip and clears a move’s eval', () => {
    const moved = updateBeat(doc, 'k1', { sourceTime: 99, actorId: undefined }, 30).evalBar!.beats[0]!;
    expect(moved.sourceTime).toBe(30);
    expect('actorId' in moved).toBe(false);
    expect('eval' in setMomentEval(doc, 'm1', undefined).moments[0]!).toBe(false);
  });

  it('keeps beats valid when their character is deleted', () => {
    expect(deleteCharacter(doc, 'w').evalBar!.beats[0]!.actorId).toBeUndefined();
  });

  it('applies a Re-evaluate result to the existing beats and moves', () => {
    const next = applyEvaluation(doc, {
      evalBar: { start: { pawns: -1 }, beats: [{ id: 'k1', sourceTime: 10, eval: { pawns: 0.5 }, reason: 'why', origin: 'ai' }, { id: 'k9', sourceTime: 25, eval: { pawns: 1 }, origin: 'ai' }] },
      evals: { m2: { pawns: 4 } },
    });
    expect(next.evalBar!.start).toEqual({ pawns: -1 });
    // Existing beats take the new values; beats the editor has not got are not added.
    expect(next.evalBar!.beats.map((b) => [b.id, b.eval, b.reason])).toEqual([['k1', { pawns: 0.5 }, 'why']]);
    expect(next.moments.map((m) => m.eval)).toEqual([{ pawns: 1 }, { pawns: 4 }]);
  });
});
