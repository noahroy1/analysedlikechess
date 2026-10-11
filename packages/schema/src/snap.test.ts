import { describe, expect, it } from 'vitest';
import { autoHoldSec, DEFAULT_REREAD_SEC, DEFAULT_TYPE_OUT, typeOutSec, typeOutStartSec } from './rules.ts';
import { cleanFrameRange, cleanFreezeTime, freezeAfterSpeech, speechSnapTargets } from './snap.ts';

const FPS = 30;
// Cuts at 3.5 s (frame 105) and 7 s (frame 210); clip ends at 10 s (frame 300).
const shots = [
  { start: 0, end: 3.5 },
  { start: 3.5, end: 7 },
  { start: 7, end: 10 },
];

describe('cleanFrameRange', () => {
  it('keeps two frames clear of each cut but not of the clip ends', () => {
    expect(cleanFrameRange(1, shots, FPS)).toEqual([0, 102]);
    expect(cleanFrameRange(5, shots, FPS)).toEqual([107, 207]);
    expect(cleanFrameRange(9, shots, FPS)).toEqual([212, 299]);
    expect(cleanFrameRange(10, shots, FPS)).toEqual([212, 299]);
  });

  it('uses the middle of a shot too short to clear both cuts', () => {
    expect(cleanFrameRange(1.02, [{ start: 0, end: 1 }, { start: 1, end: 1.1 }, { start: 1.1, end: 5 }], FPS)).toEqual([31, 31]);
  });
});

describe('cleanFreezeTime', () => {
  it('rounds to a frame', () => {
    expect(cleanFreezeTime(2.01, shots, FPS)).toBe(60 / FPS);
  });

  it('pushes a freeze off the frames around a cut', () => {
    expect(cleanFreezeTime(3.49, shots, FPS)).toBe(102 / FPS);
    expect(cleanFreezeTime(3.5, shots, FPS)).toBe(107 / FPS);
  });

  it('works without shots', () => {
    expect(cleanFreezeTime(3.49, [], FPS)).toBe(105 / FPS);
  });
});

describe('freezeAfterSpeech', () => {
  it('freezes 0.15 s after the last word', () => {
    expect(freezeAfterSpeech(1.85, shots, FPS)).toBe(2);
  });

  it('stays in the shot the line ends in when the padding would cross a cut', () => {
    // Line ends at 3.45 s; 3.6 s would be the next shot. Freeze on the last clean frame instead.
    expect(freezeAfterSpeech(3.45, shots, FPS)).toBe(102 / FPS);
  });

  it('a line ending exactly on a cut belongs to the outgoing shot', () => {
    expect(freezeAfterSpeech(3.5, shots, FPS)).toBe(102 / FPS);
  });
});

describe('speechSnapTargets', () => {
  it('gives one sorted target per distinct word end', () => {
    const words = [
      { i: 0, text: 'a', start: 0.5, end: 1, speaker: 'A' },
      { i: 1, text: 'b', start: 1.1, end: 3.45, speaker: 'A' },
      { i: 2, text: 'c', start: 3.46, end: 3.5, speaker: 'A' },
    ];
    expect(speechSnapTargets(words, shots, FPS)).toEqual([35 / FPS, 102 / FPS]);
  });
});

const defaultTiming = { badgeDelaySec: 0, badgePopSec: 0, cardInSec: 0.25, typeOut: DEFAULT_TYPE_OUT, rereadSec: DEFAULT_REREAD_SEC, cardOutSec: 0.2 };

describe('autoHoldSec', () => {
  // Card in and out total 0.5 s and the reread is 4 s, so expectations are exact.
  const timing = { badgeDelaySec: 0, badgePopSec: 0, cardInSec: 0.3, typeOut: { wordsPerSec: 5, wordFadeSec: 0.2 }, rereadSec: 4, cardOutSec: 0.2 };

  it('is the card animations plus the reread for an empty explanation', () => {
    expect(autoHoldSec({ explanation: '' }, timing)).toBe(4.5);
    expect(autoHoldSec({ explanation: ' \n ' }, timing)).toBe(4.5);
  });

  it('adds the type-out: a word every 1 / wordsPerSec, the last one fading in', () => {
    expect(typeOutSec('one', timing.typeOut)).toBeCloseTo(0.2);
    expect(typeOutSec(' one  two three four five six ', timing.typeOut)).toBeCloseTo(1.2);
    expect(autoHoldSec({ explanation: 'one two three four five six' }, timing)).toBe(5.7);
  });

  it('matches the creator: a 27-word breakdown holds about 9.4 s', () => {
    const words = Array.from({ length: 27 }, (_, i) => `w${i}`).join(' ');
    expect(autoHoldSec({ explanation: words }, defaultTiming)).toBeCloseTo(9.3, 1);
  });
});

describe('typeOutStartSec', () => {
  it('waits for a badge beside the card to pop, then for the card', () => {
    expect(typeOutStartSec({ badgeDelaySec: 0.3, badgePopSec: 0.2, cardInSec: 0.25 })).toBeCloseTo(0.75);
    expect(typeOutStartSec({ badgeDelaySec: 0, badgePopSec: 0, cardInSec: 0.25 })).toBe(0.25);
  });
});
