import { z } from 'zod';

/** Ordered best to worst. Keys 1 to 0 in the editor map onto this order. */
export const CLASSIFICATIONS = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
] as const;

export const ClassificationSchema = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * Ratings that never carry a `bestMove`: the character already played it, or
 * the move was the expected one. The editor clears it and cards never show it.
 */
export const NO_BEST_MOVE: ReadonlySet<Classification> = new Set(['brilliant', 'great', 'best', 'book']);
