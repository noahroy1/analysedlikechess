import { z } from 'zod';
import type { Classification } from './classification.ts';

/**
 * Chess sound effects. They belong to the game, not to a creator's look, so
 * every theme shares them. Each is an optional file named `<id>.<ext>` in the
 * server's sounds folder (`media/sounds` by default); a missing file is skipped.
 */
export const SOUND_IDS = [
  // The video's first and last frames, and ten seconds before the end.
  'game-start',
  'game-end',
  'game-ten-seconds-remaining',
  // On a hold's first frozen frame, before the move sound.
  'hold-open',
  // The move sound when its rating has none of its own: White's, then Black's.
  'move-self',
  'move-opponent',
  'move-capture',
  // A rating's own move sound, used when its file exists.
  'move-brilliant',
  'move-great',
  'move-best',
  'move-excellent',
  'move-good',
  'move-book',
  'move-inaccuracy',
  'move-mistake',
  'move-miss',
  'move-blunder',
  // Typing under the type-out: a loopable bed, its ending, and space-bar presses laid on top.
  'typing-start-middle',
  'typing-end',
  'typing-space-1',
  'typing-space-2',
  'typing-space-3',
] as const;

export const SoundIdSchema = z.enum(SOUND_IDS);
export type SoundId = z.infer<typeof SoundIdSchema>;

export const moveSoundId = (classification: Classification): SoundId => `move-${classification}`;

export const SoundFileSchema = z.object({
  /** URL the Player and the renderer can both load. */
  src: z.string().min(1),
  durationSec: z.number().positive(),
});
export type SoundFile = z.infer<typeof SoundFileSchema>;

/** The sounds that exist, by id. */
export const SoundBankSchema = z.partialRecord(SoundIdSchema, SoundFileSchema);
export type SoundBank = z.infer<typeof SoundBankSchema>;
