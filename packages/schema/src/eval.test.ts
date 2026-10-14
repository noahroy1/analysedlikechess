import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FORMAT_RULES,
  ProjectSchema,
  capBeat,
  evalFill,
  evalKeyframes,
  evalLeader,
  evalWarnings,
  formatEval,
  formatEvalSigned,
  parseEval,
  swingFits,
  type Character,
  type Moment,
  type Project,
} from './index.ts';

const loadFixture = (): Project =>
  JSON.parse(readFileSync(new URL('../../../fixtures/sample/project.json', import.meta.url), 'utf8'));

describe('evalFill', () => {
  it('matches the bar heights measured on the creator videos', () => {
    // Pawns → share of the bar that is White's, from style-sound-demo-*.mov.
    const measured: [number, number][] = [
      [0.5, 0.547],
      [0.8, 0.574],
      [1.0, 0.591],
      [1.8, 0.66],
      [3.8, 0.803],
      [-1.0, 0.41],
    ];
    for (const [pawns, fill] of measured) expect(Math.abs(evalFill({ pawns }) - fill)).toBeLessThan(0.006);
  });

  it('fills the bar for a mate', () => {
    expect(evalFill({ mate: 4 })).toBe(1);
    expect(evalFill({ mate: -6 })).toBe(0);
  });
});

describe('labels', () => {
  it('reads unsigned at the leader’s end', () => {
    expect(formatEval({ pawns: -0.8 })).toBe('0.8');
    expect(formatEval({ mate: -6 })).toBe('M6');
    expect(evalLeader({ pawns: -0.8 })).toBe('black');
    expect(evalLeader({ pawns: 0 })).toBe('white');
    expect(evalLeader({ mate: 3 })).toBe('white');
  });

  it('parses what the editor accepts and round-trips it', () => {
    expect(parseEval('1')).toEqual({ pawns: 1 });
    expect(parseEval('+2.55')).toEqual({ pawns: 2.6 });
    expect(parseEval(' -0.8 ')).toEqual({ pawns: -0.8 });
    expect(parseEval('M4')).toEqual({ mate: 4 });
    expect(parseEval('#4')).toEqual({ mate: 4 });
    expect(parseEval('-m6')).toEqual({ mate: -6 });
    for (const bad of ['', 'M0', 'abc', '1.2.3', '200']) expect(parseEval(bad)).toBeUndefined();
    for (const e of [{ pawns: 1.5 }, { pawns: -0.3 }, { pawns: 0 }, { mate: 2 }, { mate: -7 }]) {
      expect(parseEval(formatEvalSigned(e))).toEqual(e);
    }
  });
});

describe('ratings and the bar', () => {
  it('lets good moves gain and bad ones lose, for the side that moved', () => {
    expect(swingFits('great', 'black', { mate: 7 }, { pawns: 1 })).toBe(true);
    expect(swingFits('great', 'white', { mate: 7 }, { pawns: 1 })).toBe(false);
    expect(swingFits('inaccuracy', 'white', { pawns: 1 }, { pawns: 0.4 })).toBe(true);
    expect(swingFits('blunder', 'black', { pawns: 1 }, { pawns: 0.4 })).toBe(false);
    expect(swingFits('good', 'white', { pawns: 1 }, { pawns: -3 })).toBe(true);
    // Holding steady fits either way.
    expect(swingFits('best', 'white', { mate: 4 }, { mate: 6 })).toBe(true);
  });

  it('caps a beat’s swing and keeps its direction', () => {
    expect(capBeat({ pawns: 0.3 }, { pawns: 0.6 }, 0.06)).toEqual({ pawns: 0.6 });
    const capped = capBeat({ pawns: 0 }, { pawns: -4 }, 0.06);
    expect(evalFill(capped)).toBeCloseTo(0.44, 2);
    expect(evalFill(capBeat({ mate: 5 }, { pawns: 1 }, 0.06))).toBeCloseTo(0.94, 2);
    // Short-form beats may move further.
    expect(evalFill(capBeat({ pawns: 0 }, { pawns: -4 }, FORMAT_RULES.short.beatMaxSwing))).toBeCloseTo(0.42, 2);
  });
});

describe('the track', () => {
  const characters: Character[] = [
    { id: 'w', name: 'Walt', speakerLabels: [], side: 'white' },
    { id: 'b', name: 'Hank', speakerLabels: [], side: 'black' },
  ];
  const moments = loadFixture().moments.map((m, i): Moment => ({ ...m, actorId: i % 2 ? 'b' : 'w' }));

  it('orders moves and beats, chains each from the one before, and skips moves without an eval', () => {
    const [m1, m2, m3] = moments as [Moment, Moment, Moment];
    const track = evalKeyframes(
      { start: { pawns: 0.2 }, beats: [{ id: 'k1', sourceTime: m2.sourceTime, eval: { pawns: 0.4 }, origin: 'ai' }] },
      [{ ...m1, eval: { pawns: 1 } }, m2, { ...m3, eval: { mate: 3 } }],
      characters,
    );
    expect(track.map((k) => k.id)).toEqual([m1.id, 'k1', m3.id]);
    expect(track.map((k) => k.before)).toEqual([{ pawns: 0.2 }, { pawns: 1 }, { pawns: 0.4 }]);
    expect(track[0]!.side).toBe('white');
  });

  it('warns about a move against its rating, a big beat and a missing eval', () => {
    const [m1, m2] = moments as [Moment, Moment];
    const warnings = evalWarnings(
      { start: { pawns: 0 }, beats: [{ id: 'k1', sourceTime: m2.sourceTime + 3, eval: { pawns: 5 }, origin: 'user' }] },
      [{ ...m1, classification: 'blunder', eval: { pawns: 2 } }, m2],
      characters,
      'long',
    );
    expect(warnings.get(m1.id)).toEqual(['The bar rises for Walt on a blunder']);
    expect(warnings.get(m2.id)).toEqual(['No eval: the bar holds through this move']);
    expect(warnings.get('k1')?.[0]).toMatch(/^Moves the bar \d+%/);
  });

  it('lets short-form beats come closer together and move further', () => {
    const [m1] = moments as [Moment];
    const bar = { start: { pawns: 0 }, beats: [{ id: 'k1', sourceTime: m1.sourceTime + 1.5, eval: { pawns: 1.4 }, origin: 'user' as const }] };
    const track = [{ ...m1, eval: { pawns: 0.6 } }];
    // 1.5 s after the move and 7% of the bar.
    expect(evalWarnings(bar, track, characters, 'long').get('k1')).toHaveLength(2);
    expect(evalWarnings(bar, track, characters, 'short').get('k1')).toBeUndefined();
  });

  it('is a hard error for a beat to share a moment’s id or come out of order', () => {
    const project = loadFixture();
    const bad = {
      ...project,
      evalBar: {
        start: { pawns: 0 },
        beats: [
          { id: 'b2', sourceTime: 5, eval: { pawns: 1 }, origin: 'ai' },
          { id: project.moments[0]!.id, sourceTime: 2, eval: { pawns: 1 }, origin: 'ai' },
        ],
      },
    };
    const result = ProjectSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((i) => i.message);
    expect(messages).toContain(`beat id "${project.moments[0]!.id}" is also a moment id`);
    expect(messages).toContain('beats must be sorted by sourceTime');
  });
});
