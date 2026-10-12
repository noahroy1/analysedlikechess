import { BEAT_MAX_SWING, evalFill, type Character, type Evaluation, type Moment, type Project } from '@als/schema';
import { describe, expect, it } from 'vitest';
import { applyEvaluation, evaluationItems, placeBeats, type EvalTrack } from './evaluate.ts';

const characters: Character[] = [
  { id: 'w', name: 'Walt', speakerLabels: [], side: 'white' },
  { id: 'b', name: 'Hank', speakerLabels: [], side: 'black' },
];

const moment = (id: string, sourceTime: number, actorId: string, classification: Moment['classification']): Moment => ({
  id,
  sourceTime,
  holdSec: 8,
  actorId,
  classification,
  moveLabel: id,
  explanation: `${id} explained.`,
  card: { anchor: 'top-right', scale: 1 },
  evidence: { utteranceIds: [] },
  origin: 'ai',
  status: 'draft',
});

const answer = (start: number, evals: [string, number | null, number | null][]): Evaluation => ({
  start: { pawns: start, mate: null },
  evals: evals.map(([id, pawns, mate]) => ({ id, pawns, mate, reason: `why ${id}` })),
});

const track = (moments: Moment[], beats: EvalTrack['evalBar']['beats'] = []): EvalTrack => ({
  moments,
  characters,
  evalBar: { start: { pawns: 0 }, beats },
});

describe('applyEvaluation', () => {
  it('writes the answer into moves and beats', () => {
    const applied = applyEvaluation(
      track([moment('m1', 10, 'w', 'great')], [{ id: 'k1', sourceTime: 5, eval: { pawns: 0 }, origin: 'ai' }]),
      answer(0.3, [
        ['k1', 0.5, null],
        ['m1', null, 4],
      ]),
    );
    expect(applied.evalBar).toEqual({ start: { pawns: 0.3 }, beats: [{ id: 'k1', sourceTime: 5, eval: { pawns: 0.5 }, reason: 'why k1', origin: 'ai' }] });
    expect(applied.moments[0]!.eval).toEqual({ mate: 4 });
    expect(applied.adjusted).toEqual([]);
  });

  it('holds the bar steady when a rating would move it the wrong way for the mover', () => {
    const applied = applyEvaluation(
      track([moment('m1', 10, 'w', 'blunder'), moment('m2', 20, 'b', 'brilliant')]),
      answer(0, [
        ['m1', 1.5, null], // a blunder by White that helps White
        ['m2', 3, null], // a brilliant by Black that helps White
      ]),
    );
    expect(applied.moments.map((m) => m.eval)).toEqual([{ pawns: 0 }, { pawns: 0 }]);
    expect(applied.adjusted.map((a) => a.id)).toEqual(['m1', 'm2']);
  });

  it('caps beats and never lets one start a mate', () => {
    const applied = applyEvaluation(
      track([], [
        { id: 'k1', sourceTime: 5, eval: { pawns: 0 }, origin: 'ai' },
        { id: 'k2', sourceTime: 9, eval: { pawns: 0 }, origin: 'ai' },
      ]),
      answer(0, [
        ['k1', 4, null],
        ['k2', null, 2],
      ]),
    );
    const [k1, k2] = applied.evalBar.beats;
    expect(evalFill(k1!.eval) - 0.5).toBeCloseTo(BEAT_MAX_SWING, 2);
    expect('pawns' in k2!.eval).toBe(true);
    expect(evalFill(k2!.eval) - evalFill(k1!.eval)).toBeLessThanOrEqual(BEAT_MAX_SWING + 0.005);
    expect(applied.adjusted.map((a) => a.reason)).toEqual(['capped to a beat-sized swing', 'capped to a beat-sized swing']);

    // From a crushing position a mate is a tiny swing, but still not a beat's to start.
    const crushing = applyEvaluation(track([], [{ id: 'k1', sourceTime: 5, eval: { pawns: 0 }, origin: 'ai' }]), answer(12, [['k1', null, 2]]));
    expect('pawns' in crushing.evalBar.beats[0]!.eval).toBe(true);
    expect(crushing.adjusted.map((a) => a.reason)).toEqual(['a beat cannot start a mate']);
  });

  it('keeps fixed values and does not change the moves it was given', () => {
    const kept = { ...moment('m1', 10, 'w', 'good'), eval: { pawns: -2 } };
    const input = track([kept, moment('m2', 20, 'b', 'mistake')]);
    const applied = applyEvaluation(input, answer(0, [['m1', 1, null], ['m2', -1, null]]), new Set(['m1']));
    expect(applied.moments[0]!.eval).toEqual({ pawns: -2 });
    // Black's mistake from -2 to -1 loses Black ground: it fits.
    expect(applied.moments[1]!.eval).toEqual({ pawns: -1 });
    expect(input.moments[1]!.eval).toBeUndefined();
  });
});

describe('evaluationItems', () => {
  it('lists beats and cards in order with who moved, marking fixed values', () => {
    const items = evaluationItems(
      track([{ ...moment('m1', 10, 'b', 'mistake'), eval: { mate: 2 } }], [{ id: 'k1', sourceTime: 4, eval: { pawns: 0.4 }, actorId: 'w', action: 'Smiles', origin: 'user' }]),
      new Set(['k1']),
    );
    expect(items).toEqual([
      { id: 'k1', kind: 'beat', sourceTime: 4, actor: 'Walt', side: 'white', action: 'Smiles', fixed: { pawns: 0.4 } },
      { id: 'm1', kind: 'card', sourceTime: 10, actor: 'Hank', side: 'black', classification: 'mistake', moveLabel: 'm1', explanation: 'm1 explained.' },
    ]);
  });
});

describe('placeBeats', () => {
  const project = {
    source: { fps: 24, durationSec: 60 },
    shots: [],
    transcript: { words: [], utterances: [] },
    context: { characters },
    moments: [moment('m1', 10, 'w', 'good')],
    evalBar: { start: { pawns: 0 }, beats: [{ id: 'mine', sourceTime: 30, eval: { pawns: 1 }, origin: 'user' as const }] },
  } as unknown as Project;
  const visual = (id: string, visualTimeSec: number) => ({
    id,
    actor: 'Hank',
    kind: 'visual' as const,
    action: `${id} happens`,
    alternatives: [],
    evidenceUtteranceIds: [],
    visualTimeSec,
  });

  it('turns unpicked candidates into beats clear of cards and other beats, keeping the creator’s', () => {
    const beats = placeBeats(project, [visual('c1', 11), visual('c2', 20), visual('c3', 21), visual('c4', 31), visual('c5', 45), visual('c6', 50)], new Set(['c6']));
    // c1 is too close to the card, c3 to c2, c4 to the creator's beat; c6 has a card.
    expect(beats.map((b) => [b.id, b.origin, b.actorId])).toEqual([
      ['beat-c2', 'ai', 'b'],
      ['mine', 'user', undefined],
      ['beat-c5', 'ai', 'b'],
    ]);
  });
});
