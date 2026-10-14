import { NO_BEST_MOVE } from './classification.ts';
import { FORMAT_RULES, type Format, type TextCaps } from './format.ts';
import type { Moment } from './project.ts';
import type { Theme, TypeOut } from './theme.ts';

/** Minimum gap between two moments, in source seconds. */
export const MIN_MOMENT_GAP_SEC = 0.5;

/** Character caps for a format's cards (see `FORMAT_RULES`). */
export const textCaps = (format: Format): TextCaps => FORMAT_RULES[format].textCaps;

export type CappedField = keyof TextCaps;

/**
 * The explanation types out word by word once the card is in, then the
 * finished card stays up for a reread. Measured on the creator's videos
 * (Oct 12, 2026): a new word every 0.18 s (about 5.5 words a second), each
 * fading in over 0.12 s. Themes carry their own copy in `timing`; how long
 * the finished card stays up is the format's (`rereadSec`).
 */
export const DEFAULT_TYPE_OUT: TypeOut = { wordsPerSec: 5.5, wordFadeSec: 0.12 };

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
 * explanation typing out, the format's reread, then the card animating out.
 * Rounded to 0.1 s.
 */
export function autoHoldSec(
  moment: Pick<Moment, 'explanation'>,
  timing: Pick<Theme['timing'], 'badgeDelaySec' | 'badgePopSec' | 'cardInSec' | 'typeOut' | 'cardOutSec'>,
  format: Format,
): number {
  const sec =
    typeOutStartSec(timing) +
    typeOutSec(moment.explanation, timing.typeOut) +
    FORMAT_RULES[format].rereadSec +
    timing.cardOutSec;
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
export function momentWarnings(moment: Moment, format: Format): MomentWarning[] {
  const warnings: MomentWarning[] = [];
  const caps = textCaps(format);
  for (const field of Object.keys(caps) as CappedField[]) {
    const length = moment[field]?.length ?? 0;
    const cap = caps[field];
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
