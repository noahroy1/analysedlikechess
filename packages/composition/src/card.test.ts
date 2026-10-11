import { describe, expect, it } from 'vitest';
import { revealAt } from './card.ts';

const timing = { cardInSec: 0.25, typeOut: { wordsPerSec: 5, wordFadeSec: 0.1 }, rereadSec: 4, cardOutSec: 0.25 };
const text = 'one two three four five';
const shown = (t: number, holdSec = 10) => revealAt(text, t, holdSec, timing);

describe('revealAt', () => {
  it('shows nothing until the card is in', () => {
    expect(shown(-0.2)).toEqual({ words: [], after: 0 });
    expect(shown(0)).toEqual({ words: [], after: 0 });
  });

  it('starts a word every 1 / wordsPerSec, the newest fading in', () => {
    const r = shown(0.25);
    expect(r.words.map((w) => w.text)).toEqual(['one', 'two']);
    expect(r.words[0]!.opacity).toBe(1);
    expect(r.words[1]!.opacity).toBeCloseTo(0.5);
    expect(r.after).toBe(0);
  });

  it('brings in the best move once the last word is in', () => {
    // Last word starts at 0.8 s and is in at 0.9 s.
    expect(shown(0.85).after).toBe(0);
    expect(shown(0.95).after).toBeCloseTo(0.5);
    const done = shown(1.5);
    expect(done.words.map((w) => w.opacity)).toEqual([1, 1, 1, 1, 1]);
    expect(done.after).toBe(1);
  });

  it('types faster when a hand-set hold is too short, finishing before the card leaves', () => {
    // 0.9 s of typing must fit in 0.6 - 0.25 - 0.25 = 0.1 s.
    const r = shown(0.1, 0.6);
    expect(r.words).toHaveLength(5);
    expect(r.words.every((w) => w.opacity === 1)).toBe(true);
  });

  it('collapses runs of whitespace', () => {
    expect(revealAt('  a\n\n b  ', 5, 10, timing).words.map((w) => w.text)).toEqual(['a', 'b']);
  });
});
