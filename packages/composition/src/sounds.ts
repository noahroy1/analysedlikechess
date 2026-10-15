import {
  moveSoundId,
  typeOutStartSec,
  typedWords,
  type Character,
  type Classification,
  type Moment,
  type SoundBank,
  type SoundId,
  type Theme,
} from '@als/schema';
import { typeOutSpeed } from './card.ts';
import { hash, mulberry32 } from './random.ts';
import type { Timeline } from './timeline.ts';

// When each chess sound plays. Measured on the creator's videos (Oct 12, 2026),
// by cross-correlating the sound files with the clips' audio:
//   - the freeze itself is silent; the move sound starts 0.27-0.29 s in, as the
//     badge pops (0.3 s), so it plays on the badge;
//   - typing runs from the first word to the last and is silent for the reread.
// The typing recording plays at its own pace (97 WPM), not the text's, as the
// creator's does: speeding it up to the text would raise its pitch.

/** Seconds before the end when the low-time warning plays. */
export const TEN_SECONDS = 10;
/** Seconds into the video when game-start plays: a beat in, so it is heard rather than lost on the first frame (the user's choice, Oct 13). */
export const GAME_START_SEC = 1;

/** Words per minute of the typing recording. */
export const TYPING_WPM = 97;
/** A word in WPM is five keystrokes including its space, so the recording has a space every 60/97 s. */
export const SPACE_EVERY_SEC = 60 / TYPING_WPM;
/** Last keystroke in `typing-end`, after which it fades out: lined up with the last word. */
export const TYPING_END_LAST_KEY_SEC = 1.24;

const SPACES = ['typing-space-1', 'typing-space-2', 'typing-space-3'] as const satisfies readonly SoundId[];

/**
 * Ratings without a file of their own borrow another rating's before falling
 * back to the side's move sound. The creator plays the mistake sound on inaccuracies.
 */
const BORROWED: Partial<Record<Classification, SoundId>> = { inaccuracy: 'move-mistake' };

export interface SoundCue {
  /** Stable React key. */
  key: string;
  sound: SoundId;
  src: string;
  /** Output frame the sound starts on. */
  from: number;
  /** Frames it plays for. */
  frames: number;
  /** Frames skipped from the start of the file. */
  trimBefore?: number;
  /** Repeats the file to fill `frames`. */
  loop?: boolean;
}

export interface SoundCueInput {
  timeline: Timeline;
  moments: readonly Moment[];
  characters: readonly Character[];
  timing: Theme['timing'];
  sounds: SoundBank;
}

/** The move sound for a moment: its rating's own, a borrowed one, else White's or Black's. */
export function moveSound(moment: Pick<Moment, 'classification' | 'actorId'>, characters: readonly Character[], sounds: SoundBank): SoundId | undefined {
  const own = moveSoundId(moment.classification);
  if (sounds[own]) return own;
  const borrowed = BORROWED[moment.classification];
  if (borrowed && sounds[borrowed]) return borrowed;
  const side = characters.find((c) => c.id === moment.actorId)?.side;
  const generic = side === 'black' ? 'move-opponent' : 'move-self';
  return sounds[generic] ? generic : undefined;
}

/**
 * Every sound in the episode, in output frames. Pure, so the Player and the
 * renderer play the same cues. Sounds missing from the bank are skipped.
 */
export function soundCues({ timeline, moments, characters, timing, sounds }: SoundCueInput): SoundCue[] {
  const { fps } = timeline;
  const cues: SoundCue[] = [];
  const toFrames = (sec: number) => Math.round(sec * fps);
  const fileFrames = (id: SoundId) => Math.max(1, Math.ceil((sounds[id]?.durationSec ?? 0) * fps));
  const add = (key: string, sound: SoundId, from: number, frames = fileFrames(sound), extra: Pick<SoundCue, 'trimBefore' | 'loop'> = {}) => {
    const file = sounds[sound];
    if (file && frames > 0) cues.push({ key, sound, src: file.src, from, frames, ...extra });
  };

  // The game ends on the clip's last frame; the review (if any) follows in silence.
  const end = timeline.gameReview?.outStart ?? timeline.outFrames;
  // A video shorter than the delay plays it on its first frame.
  const start = toFrames(GAME_START_SEC);
  add('game-start', 'game-start', Number.isFinite(end) && start >= end ? 0 : start);
  if (Number.isFinite(end)) {
    if (end > toFrames(TEN_SECONDS)) add('ten-seconds', 'game-ten-seconds-remaining', end - toFrames(TEN_SECONDS));
    // Finishes on the clip's last frame, so the review shows once it has played.
    add('game-end', 'game-end', Math.max(0, end - fileFrames('game-end')));
  }

  for (const hold of timeline.holds) {
    const moment = moments[hold.index];
    if (!moment) continue;
    add(`${moment.id}:open`, 'hold-open', hold.outStart);
    const move = moveSound(moment, characters, sounds);
    if (move) add(`${moment.id}:move`, move, hold.outStart + toFrames(timing.badgeDelaySec));
    cues.push(...typingCues(moment, hold.outStart, hold.frames, timing, sounds, fps));
  }
  return cues.sort((a, b) => a.from - b.from);
}

/**
 * Typing under one card's type-out, following `revealAt()`: the loopable bed
 * from the first word, then `typing-end` placed so its last keystroke lands on
 * the last word, with space-bar presses at the recording's own word rate,
 * each snapped to a word appearing.
 */
function typingCues(moment: Moment, holdOut: number, holdFrames: number, timing: Theme['timing'], sounds: SoundBank, fps: number): SoundCue[] {
  const words = typedWords(moment.explanation).length;
  const holdSec = holdFrames / fps;
  const start = typeOutStartSec(timing);
  if (words === 0 || start >= holdSec) return [];

  const cues: SoundCue[] = [];
  const speed = typeOutSpeed(moment.explanation, holdSec, timing);
  const wordAt = (i: number) => start + i / timing.typeOut.wordsPerSec / speed;
  const lastWord = wordAt(words - 1);
  const at = (sec: number) => holdOut + Math.round(sec * fps);
  const holdEnd = holdOut + holdFrames;
  const push = (cue: Omit<SoundCue, 'src'>) => {
    const file = sounds[cue.sound];
    const frames = Math.min(cue.frames, holdEnd - cue.from);
    if (file && frames > 0) cues.push({ ...cue, src: file.src, frames });
  };

  const typingStart = at(start);
  const end = sounds['typing-end'];
  const endFrom = end ? at(lastWord - TYPING_END_LAST_KEY_SEC) : undefined;
  // Without an ending the bed stops as the last word is fully in.
  const bedTo = endFrom ?? at(lastWord + timing.typeOut.wordFadeSec / speed);
  const bed = sounds['typing-start-middle'];
  if (bed && bedTo > typingStart) {
    const frames = bedTo - typingStart;
    push({ key: `${moment.id}:typing`, sound: 'typing-start-middle', from: typingStart, frames, ...(frames > bed.durationSec * fps ? { loop: true } : {}) });
  }
  if (end && endFrom !== undefined) {
    // A short type-out starts partway into the ending.
    const from = Math.max(typingStart, endFrom);
    const trimBefore = from - endFrom;
    push({
      key: `${moment.id}:typing-end`,
      sound: 'typing-end',
      from,
      frames: Math.ceil(end.durationSec * fps) - trimBefore,
      ...(trimBefore > 0 ? { trimBefore } : {}),
    });
  }

  const spaces = SPACES.filter((id) => sounds[id]);
  if (spaces.length > 0 && words > 1) {
    const random = mulberry32(hash(moment.id));
    let prevWord = 0;
    let prevSound: SoundId | undefined;
    for (let k = 1; start + k * SPACE_EVERY_SEC <= lastWord; k++) {
      const word = Math.min(words - 1, Math.max(1, Math.round(k * SPACE_EVERY_SEC * timing.typeOut.wordsPerSec * speed)));
      if (word === prevWord) continue;
      // Vary the press, never the same one twice running.
      const choices = spaces.length > 1 ? spaces.filter((id) => id !== prevSound) : spaces;
      const sound = choices[Math.floor(random() * choices.length)]!;
      push({ key: `${moment.id}:space-${word}`, sound, from: at(wordAt(word)), frames: Math.ceil(sounds[sound]!.durationSec * fps) });
      prevWord = word;
      prevSound = sound;
    }
  }
  return cues;
}
