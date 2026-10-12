import { describe, expect, it } from 'vitest';
import type { Transcript, Word } from './project.ts';
import { SUBTITLE_MAX_CHARS, SUBTITLE_MIN_SEC, SUBTITLE_TAIL_SEC, subtitleAt, subtitlesFromTranscript } from './subtitles.ts';

/** A transcript of utterances, each a list of [text, start, end] words. */
function transcript(...utterances: [string, number, number][][]): Transcript {
  const words: Word[] = [];
  const result: Transcript = { words, utterances: [] };
  utterances.forEach((spoken, u) => {
    const first = words.length;
    for (const [text, start, end] of spoken) words.push({ i: words.length, text, start, end, speaker: 'A' });
    result.utterances.push({
      id: `u${u + 1}`,
      speaker: 'A',
      start: spoken[0]![1],
      end: spoken.at(-1)![2],
      text: spoken.map((w) => w[0]).join(' '),
      wordRange: [first, words.length - 1],
    });
  });
  return result;
}
/** Evenly timed words from a sentence. */
const said = (text: string, start: number, perWord = 0.25): [string, number, number][] =>
  text.split(' ').map((w, i) => [w, start + i * perWord, start + i * perWord + 0.2]);

describe('subtitlesFromTranscript', () => {
  it('puts each sentence on its own line, from its first word to just after its last', () => {
    const subs = subtitlesFromTranscript(transcript([...said('Step out of the bathroom!', 2), ...said('Now.', 5)]));
    expect(subs.map((s) => s.text)).toEqual(['Step out of the bathroom!', 'Now.']);
    expect(subs[0]).toMatchObject({ id: 'u1-1', start: 2, end: 2 + 4 * 0.25 + 0.2 + SUBTITLE_TAIL_SEC });
  });

  it('splits a long sentence near the middle, preferring a clause break', () => {
    const long = 'Look, I know where this is coming from, Hank, but you have to listen to me right now.';
    const subs = subtitlesFromTranscript(transcript(said(long, 0)));
    expect(subs.length).toBeGreaterThan(1);
    for (const s of subs) expect(s.text.length).toBeLessThanOrEqual(SUBTITLE_MAX_CHARS);
    expect(subs.map((s) => s.text).join(' ')).toBe(long);
    expect(subs[0]!.text.endsWith(',')).toBe(true);
  });

  it('keeps a short line up long enough to read, but never over the next line', () => {
    const subs = subtitlesFromTranscript(transcript([['Good.', 1, 1.1]], [['Rot.', 1.5, 1.7]], [['Hank.', 10, 10.1]]));
    expect(subs[0]!.end).toBe(1.5);
    expect(subs[2]!.end).toBeCloseTo(10 + SUBTITLE_MIN_SEC);
  });

  it('closes a short gap so the text does not flicker', () => {
    const subs = subtitlesFromTranscript(transcript([['One.', 1, 1.2]], [['Two.', 1.6, 1.8]]));
    // One ends at 1.5 (tail) and would leave a 0.1 s gap.
    expect(subs[0]!.end).toBe(1.6);
  });

  it('drops a leading ellipsis and sound tags, and attaches loose punctuation', () => {
    const subs = subtitlesFromTranscript(transcript([['...', 0, 0], ['Just', 0.1, 0.3], ['(sighs)', 0.4, 0.6], ['breathe', 0.7, 0.9], ['...', 1, 1]]));
    expect(subs.map((s) => s.text)).toEqual(['Just breathe...']);
    expect(subs[0]!.start).toBe(0.1);
  });

  it('is empty without a transcript', () => {
    expect(subtitlesFromTranscript(undefined)).toEqual([]);
  });
});

describe('subtitleAt', () => {
  const subs = [
    { id: 'a', start: 1, end: 2, text: 'one' },
    { id: 'b', start: 3, end: 4, text: 'two' },
  ];
  it('finds the line up at a time, with the end exclusive', () => {
    expect(subtitleAt(subs, 1)?.id).toBe('a');
    expect(subtitleAt(subs, 2)).toBeUndefined();
    expect(subtitleAt(subs, 3.5)?.id).toBe('b');
  });
});

describe('subtitlesFromTranscript, real-world splits', () => {
  it('splits at a comma when both halves fit, even if a word break is more even', () => {
    const subs = subtitlesFromTranscript(transcript(said('These wild accusations, they could destroy our family and more.', 0)));
    expect(subs.map((s) => s.text)).toEqual(['These wild accusations,', 'they could destroy our family and more.']);
  });

  it('folds a word timed apart from its sentence into the line before', () => {
    // BB1: "...who I'm talking" then a separate 0.02 s "to." just before the next line.
    const subs = subtitlesFromTranscript(transcript(said("I don't even know who I'm talking", 116), [['to.', 123.44, 123.46]], said("If that's true,", 123.46)));
    expect(subs.map((s) => s.text)).toEqual(["I don't even know who I'm talking to.", "If that's true,"]);
    expect(subs[0]!.start).toBe(116);
  });
});
