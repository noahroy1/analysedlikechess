import { NO_BEST_MOVE } from './classification.ts';
import type { Moment } from './project.ts';
import type { Theme, TypeOut } from './theme.ts';

/** Minimum gap between two moments, in source seconds. */
export const MIN_MOMENT_GAP_SEC = 0.5;

/**
 * Character caps from the creator's cards (five reference clips, Oct 12, 2026):
 * a two or three word move name, a two-sentence breakdown of 150 to 160
 * characters, and a better move of two to four words.
 */
export const TEXT_CAPS = {
  moveLabel: 24,
  explanation: 170,
  bestMove: 32,
  /** The chess motif chip, e.g. "Zwischenzug". */
  motif: 20,
} as const;

export type CappedField = keyof typeof TEXT_CAPS;

/**
 * The explanation types out word by word once the card is in, then the
 * finished card stays up for a reread. Measured on the creator's videos
 * (Oct 12, 2026): a new word every 0.18 s (about 5.5 words a second), each
 * fading in over 0.12 s, and about 4 s with the finished card.
 * Themes carry their own copy in `timing`.
 */
export const DEFAULT_TYPE_OUT: TypeOut = { wordsPerSec: 5.5, wordFadeSec: 0.12 };
export const DEFAULT_REREAD_SEC = 4;

/** The explanation's words, in the order they type out. */
export const typedWords = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** Seconds from the first word starting to the last word fully in. */
export function typeOutSec(explanation: string, typeOut: TypeOut): number {
  const words = typedWords(explanation).length;
  return words === 0 ? 0 : (words - 1) / typeOut.wordsPerSec + typeOut.wordFadeSec;
}

/** Seconds into a hold when the first word starts: the badge pops, then the card animates in. */
export const typeOutStartSec = (timing: Pick<Theme['timing'], 'badgeDelaySec' | 'badgePopSec' | 'cardInSec'>): number =>
  timing.badgeDelaySec + timing.badgePopSec + timing.cardInSec;

/**
 * Hold length that follows the card's text: the badge and card animating in, the
 * explanation typing out, the reread, then the card animating out.
 * Rounded to 0.1 s.
 */
export function autoHoldSec(
  moment: Pick<Moment, 'explanation'>,
  timing: Pick<Theme['timing'], 'badgeDelaySec' | 'badgePopSec' | 'cardInSec' | 'typeOut' | 'rereadSec' | 'cardOutSec'>,
): number {
  const sec =
    typeOutStartSec(timing) + typeOutSec(moment.explanation, timing.typeOut) + timing.rereadSec + timing.cardOutSec;
  return Math.round(sec * 10) / 10;
}

export interface MomentWarning {
  field: CappedField | 'bestMove';
  message: string;
}

/**
 * Soft rules: the editor shows these but still saves. Over-cap text and a
 * `bestMove` on a best/brilliant rating are warnings, not schema errors, so
 * autosave never fails mid-edit.
 */
export function momentWarnings(moment: Moment): MomentWarning[] {
  const warnings: MomentWarning[] = [];
  for (const field of Object.keys(TEXT_CAPS) as CappedField[]) {
    const length = moment[field]?.length ?? 0;
    const cap = TEXT_CAPS[field];
    if (length > cap) {
      warnings.push({ field, message: `${field} is ${length} characters, over the cap of ${cap}` });
    }
  }
  if (moment.bestMove && NO_BEST_MOVE.has(moment.classification)) {
    warnings.push({
      field: 'bestMove',
      message: `bestMove is normally omitted for ${moment.classification} moves`,
    });
  }
  return warnings;
}
