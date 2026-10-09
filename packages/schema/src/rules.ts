import { NO_BEST_MOVE } from './classification.ts';
import type { Moment } from './project.ts';

/** Minimum gap between two moments, in source seconds. */
export const MIN_MOMENT_GAP_SEC = 0.5;

/**
 * Character caps that keep a card readable during its hold.
 * TODO(open-decision): tune against the creator's real videos in Phase 6.
 */
export const TEXT_CAPS = {
  moveLabel: 40,
  explanation: 220,
  bestMove: 160,
} as const;

export type CappedField = keyof typeof TEXT_CAPS;

export interface HoldTiming {
  floorSec: number;
  wordsPerSec: number;
}

/**
 * About 1 s per 12 words with a 3 s floor.
 * TODO(open-decision): the theme supplies these once the creator's hold timing is known.
 */
export const DEFAULT_HOLD_TIMING: HoldTiming = { floorSec: 3, wordsPerSec: 12 };

/** Default hold for a card, from the words it shows. Rounded to 0.1 s. */
export function defaultHoldSec(
  moment: Pick<Moment, 'moveLabel' | 'explanation' | 'bestMove'>,
  timing: HoldTiming = DEFAULT_HOLD_TIMING,
): number {
  const text = [moment.moveLabel, moment.explanation, moment.bestMove ?? ''].join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  const sec = Math.max(timing.floorSec, words / timing.wordsPerSec);
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
