import { DEFAULT_TYPE_OUT, typedWords, type Character, type Moment, type SoundBank, type SoundId } from '@als/schema';
import { describe, expect, it } from 'vitest';
import { SPACE_EVERY_SEC, TYPING_END_LAST_KEY_SEC, moveSound, soundCues, type SoundCue } from './sounds.ts';
import { buildTimeline } from './timeline.ts';

const fps = 30;
// The creator theme's timing: the badge pops at 0.3 s, typing starts at 0.75 s.
const timing = { badgeDelaySec: 0.3, badgePopSec: 0.2, cardInSec: 0.25, typeOut: DEFAULT_TYPE_OUT, rereadSec: 4, cardOutSec: 0 };
const typeStart = 0.75;

const file = (id: SoundId, durationSec: number) => [id, { src: `/api/sounds/${id}.wav`, durationSec }] as const;
const full: SoundBank = Object.fromEntries([
  file('game-start', 0.28),
  file('game-end', 0.28),
  file('game-ten-seconds-remaining', 0.62),
  file('move-self', 0.15),
  file('move-opponent', 0.15),
  file('move-brilliant', 0.48),
  file('move-great', 0.33),
  file('move-mistake', 0.17),
  file('move-blunder', 0.5),
  file('typing-start-middle', 7.67),
  file('typing-end', 1.48),
  file('typing-space-1', 0.12),
  file('typing-space-2', 0.13),
  file('typing-space-3', 0.15),
]);

const cast: Character[] = [
  { id: 'walt', name: 'Walt', speakerLabels: [], side: 'white' },
  { id: 'hank', name: 'Hank', speakerLabels: [], side: 'black' },
];
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const moment = (id: string, sourceTime: number, over: Partial<Moment> = {}) =>
  ({ id, sourceTime, holdSec: 10, classification: 'best', actorId: 'walt', explanation: words(27), ...over }) as Moment;

const cuesFor = (moments: Moment[], sounds: SoundBank = full, durationSec = 60) =>
  soundCues({ timeline: buildTimeline(moments, fps, durationSec), moments, characters: cast, timing, sounds });
const only = (cues: SoundCue[], key: string) => cues.find((c) => c.key === key)!;
const spaceCues = (cues: SoundCue[]) => cues.filter((c) => c.sound.startsWith('typing-space'));

describe('game sounds', () => {
  it('starts on the first frame, warns ten seconds out and ends on the last frame', () => {
    const cues = cuesFor([moment('a', 5)]);
    const out = 60 * fps + 10 * fps;
    expect(only(cues, 'game-start').from).toBe(0);
    expect(only(cues, 'ten-seconds').from).toBe(out - 10 * fps);
    const end = only(cues, 'game-end');
    expect(end.from + end.frames).toBe(out);
  });

  it('skips the warning on a video under ten seconds', () => {
    expect(cuesFor([], full, 8).some((c) => c.sound === 'game-ten-seconds-remaining')).toBe(false);
  });
});

describe('moveSound', () => {
  it("plays a rating's own sound when it has one", () => {
    expect(moveSound(moment('a', 1, { classification: 'brilliant' }), cast, full)).toBe('move-brilliant');
    expect(moveSound(moment('a', 1, { classification: 'blunder', actorId: 'hank' }), cast, full)).toBe('move-blunder');
  });

  it("falls back to White's or Black's move sound", () => {
    expect(moveSound(moment('a', 1, { classification: 'best' }), cast, full)).toBe('move-self');
    expect(moveSound(moment('a', 1, { classification: 'miss', actorId: 'hank' }), cast, full)).toBe('move-opponent');
    // No side yet: White's.
    expect(moveSound(moment('a', 1, { actorId: 'extra' }), cast, full)).toBe('move-self');
  });

  it('gives an inaccuracy the mistake sound, as the creator does', () => {
    expect(moveSound(moment('a', 1, { classification: 'inaccuracy' }), cast, full)).toBe('move-mistake');
    const { 'move-mistake': _, ...noMistake } = full;
    expect(moveSound(moment('a', 1, { classification: 'inaccuracy' }), cast, noMistake)).toBe('move-self');
  });

  it('picks up a new file without code changes', () => {
    const withMiss = Object.fromEntries([...Object.entries(full), file('move-miss', 0.3)]) as SoundBank;
    expect(moveSound(moment('a', 1, { classification: 'miss' }), cast, withMiss)).toBe('move-miss');
  });
});

describe('hold sounds', () => {
  const hold = 5 * fps;
  const cues = cuesFor([moment('a', 5)]);

  it('plays the move sound as the badge pops', () => {
    expect(only(cues, 'a:move')).toMatchObject({ sound: 'move-self', from: hold + 0.3 * fps });
  });

  it('plays the opening sound on the first frozen frame, when there is one', () => {
    expect(cues.some((c) => c.sound === 'hold-open')).toBe(false);
    const withOpen = Object.fromEntries([...Object.entries(full), file('hold-open', 0.2)]) as SoundBank;
    expect(only(cuesFor([moment('a', 5)], withOpen), 'a:open').from).toBe(hold);
  });

  it('types from the first word, then lands the ending on the last word', () => {
    // 27 words: the last starts 26 / 5.5 s after the first.
    const lastWord = typeStart + 26 / DEFAULT_TYPE_OUT.wordsPerSec;
    const bed = only(cues, 'a:typing');
    const end = only(cues, 'a:typing-end');
    expect(bed.from).toBe(hold + Math.round(typeStart * fps));
    expect(bed.loop).toBeUndefined();
    expect(end.from).toBe(hold + Math.round((lastWord - TYPING_END_LAST_KEY_SEC) * fps));
    expect(bed.from + bed.frames).toBe(end.from);
    expect(end.trimBefore).toBeUndefined();
  });

  it('loops the bed under a type-out longer than the recording', () => {
    const long = cuesFor([moment('a', 5, { explanation: words(60), holdSec: 20 })]);
    expect(only(long, 'a:typing').loop).toBe(true);
  });

  it('starts partway into the ending when the type-out is shorter than it', () => {
    const short = cuesFor([moment('a', 5, { explanation: words(3) })]);
    expect(short.some((c) => c.key === 'a:typing')).toBe(false);
    const end = only(short, 'a:typing-end');
    expect(end.from).toBe(hold + Math.round(typeStart * fps));
    expect(end.trimBefore).toBeGreaterThan(0);
  });

  it('presses space at the recording’s word rate, each on a word appearing', () => {
    const spaces = spaceCues(cues);
    const lastWord = typeStart + 26 / DEFAULT_TYPE_OUT.wordsPerSec;
    expect(spaces).toHaveLength(Math.floor((lastWord - typeStart) / SPACE_EVERY_SEC));
    const onsets = typedWords(words(27)).map((_, i) => hold + Math.round((typeStart + i / DEFAULT_TYPE_OUT.wordsPerSec) * fps));
    for (const s of spaces) expect(onsets).toContain(s.from);
    for (let i = 1; i < spaces.length; i++) expect(spaces[i]!.sound).not.toBe(spaces[i - 1]!.sound);
  });

  it('is the same on every render', () => {
    expect(cuesFor([moment('a', 5)])).toEqual(cues);
  });

  it('keeps typing inside a short hand-set hold, typing faster', () => {
    const locked = cuesFor([moment('a', 5, { holdSec: 2, holdLocked: true })]);
    const holdEnd = hold + 2 * fps;
    for (const c of locked.filter((c) => c.sound.startsWith('typing'))) expect(c.from + c.frames).toBeLessThanOrEqual(holdEnd);
    expect(spaceCues(locked).length).toBeGreaterThan(0);
  });

  it('plays nothing without a sound bank entry', () => {
    expect(cuesFor([moment('a', 5)], {})).toEqual([]);
  });
});
