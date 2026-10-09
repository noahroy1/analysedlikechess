import { describe, expect, it } from 'vitest';
import { autoHoldSec, DEFAULT_HOLD_TIMING } from './rules.ts';
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

describe('autoHoldSec', () => {
  // Card in and out total 0.5 s here, so expectations are exact.
  const timing = { hold: DEFAULT_HOLD_TIMING, cardInSec: 0.3, cardOutSec: 0.2 };

  it('is the card animations plus the padding for an empty card', () => {
    expect(autoHoldSec({ moveLabel: '', explanation: '' }, timing)).toBe(1.5);
  });

  it('adds reading time at 34 characters a second', () => {
    expect(autoHoldSec({ moveLabel: 'x'.repeat(34), explanation: 'y'.repeat(102), bestMove: 'z'.repeat(34) }, timing)).toBe(6.5);
  });

  it('ignores surrounding whitespace', () => {
    expect(autoHoldSec({ moveLabel: '   ', explanation: ' '.repeat(50) }, timing)).toBe(1.5);
  });
});
