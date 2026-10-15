import { z } from 'zod';

// Two kinds of episode. Long-form is the creator's movie-scene breakdown (an
// 8-minute video read at leisure); short-form is a vertical clip where keeping
// attention matters most, so cards come faster and hold briefly. Everything
// here is pacing; how a card looks stays with the theme.

export const FORMATS = ['short', 'long'] as const;
export const FormatSchema = z.enum(FORMATS);
export type Format = z.infer<typeof FormatSchema>;

export interface TextCaps {
  moveLabel: number;
  explanation: number;
  bestMove: number;
  /** The chess motif chip, e.g. "Zwischenzug". */
  motif: number;
}

/**
 * Character caps from the creator's cards (five reference clips, Oct 12, 2026):
 * a two or three word move name, a two-sentence breakdown of 150 to 160
 * characters, and a better move of two to four words. Both formats write the
 * same card: one-sentence short-form breakdowns (Oct 15) read flatter, and the
 * breakdown is what makes the videos entertaining.
 */
export const CARD_TEXT_CAPS: TextCaps = { moveLabel: 24, explanation: 170, bestMove: 32, motif: 20 };

export interface FormatRules {
  name: string;
  /** Pass B's target density: about one card per this many source seconds. */
  secondsPerMove: number;
  /** Drafted cards closer than this to a kept card are dropped, so cards never bunch up. */
  minCardGapSec: number;
  /** Seconds the finished card stays up after the last word, for a reread. */
  rereadSec: number;
  /** Character caps; over them the editor warns (`momentWarnings`). */
  textCaps: TextCaps;
  /** Book moves only in the first this many source seconds; later ones are rated good. */
  bookWindowSec: number;
  /** A beat closer than this to another change of the bar is dropped. */
  beatClearanceSec: number;
  /** At most this many beats per card, so the cards, not the beats, move the bar. */
  beatsPerCard: number;
  /** Beats move the bar at most this share of it, so big swings get a card. */
  beatMaxSwing: number;
}

export const FORMAT_RULES: Record<Format, FormatRules> = {
  /**
   * Measured on the creator's movie-scene videos (Catch Me If You Can, five
   * clips, Oct 12, 2026): a card about every 20 s, two-sentence breakdowns of
   * 150-160 characters, and about 4 s with the finished card.
   */
  long: {
    name: 'Long-form',
    secondsPerMove: 20,
    // Not measured: the creator's cards were about 20 s apart, so 8 s only stops bunching.
    minCardGapSec: 8,
    rereadSec: 4,
    textCaps: CARD_TEXT_CAPS,
    bookWindowSec: 30,
    beatClearanceSec: 2.5,
    // Not measured; BB1's hand-written bar had one beat per card.
    beatsPerCard: 2,
    beatMaxSwing: 0.06,
  },
  /**
   * Measured on the user's short-form benchmark (Private Property, a 70 s
   * vertical clip edited by hand, Oct 15, 2026): a card every 8.8 s (gaps
   * 5.4-11.4 s), the first at 4.4 s; holds of 2.7-5 s, which leave 1.1-1.8 s
   * (median 1.4) with the finished card; six beats for eight cards, as close
   * as 1.1 s apart, each moving the bar 3-7.5%. Its one-sentence breakdowns
   * are not copied (see `CARD_TEXT_CAPS`), so holds here run longer than its
   * 2.7-5 s: about 7 s for a 27-word breakdown.
   */
  short: {
    name: 'Short-form',
    secondsPerMove: 9,
    minCardGapSec: 4,
    rereadSec: 1.4,
    textCaps: CARD_TEXT_CAPS,
    bookWindowSec: 10,
    beatClearanceSec: 1,
    beatsPerCard: 1,
    beatMaxSwing: 0.08,
  },
};

/**
 * The format a new clip most likely is: vertical clips are short-form. A
 * landscape clip is a scene for a long-form video whatever its length, so
 * length is not a clue.
 */
export const guessFormat = (source: { width: number; height: number }): Format =>
  source.height > source.width ? 'short' : 'long';

/** A project's format: as set in the editor, else guessed from its clip. */
export const projectFormat = (project: { format?: Format | undefined; source: { width: number; height: number } }): Format =>
  project.format ?? guessFormat(project.source);
