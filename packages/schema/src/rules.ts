import { NO_BEST_MOVE } from './classification.ts';
import type { Moment } from './project.ts';

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
} as const;

export type CappedField = keyof typeof TEXT_CAPS;

export interface HoldTiming {
  /** Reading speed for the card's text. */
  charsPerSec: number;
  /** Added once the text is read, for rereads. */
  paddingSec: number;
}

/**
 * Half the time per character of the usual 17 characters a second subtitle
 * reading speed (the creator's call, Oct 10, 2026), plus a second to reread.
 * Themes carry their own copy in `timing.hold`.
 * TODO(open-decision): tune against the creator's videos in Phase 6.
 */
export const DEFAULT_HOLD_TIMING: HoldTiming = { charsPerSec: 34, paddingSec: 1 };

/** Everything a viewer reads on the card. */
export const cardTextLength = (moment: Pick<Moment, 'moveLabel' | 'explanation' | 'bestMove'>): number =>
  moment.moveLabel.trim().length + moment.explanation.trim().length + (moment.bestMove?.trim().length ?? 0);

/**
 * Hold length that follows the card's text: the card animating in, reading
 * time for every character, the reread padding, then the card animating out.
 * Rounded to 0.1 s.
 */
export function autoHoldSec(
  moment: Pick<Moment, 'moveLabel' | 'explanation' | 'bestMove'>,
  timing: { hold: HoldTiming; cardInSec: number; cardOutSec: number },
): number {
  const sec =
    timing.cardInSec + cardTextLength(moment) / timing.hold.charsPerSec + timing.hold.paddingSec + timing.cardOutSec;
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
