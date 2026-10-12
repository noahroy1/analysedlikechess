import { z } from 'zod';
import { EvalBarSchema } from './eval.ts';
import { CharacterSchema, MomentSchema } from './project.ts';
import { SoundBankSchema } from './sounds.ts';
import { ThemeSchema } from './theme.ts';

/**
 * Everything the <Episode> composition draws from. The Player gets it from the
 * editor; the renderer gets a frozen snapshot. Nothing else reaches the composition.
 */
export const EpisodePropsSchema = z.object({
  /** Video URL: the proxy in the Player, the original file when rendering. */
  src: z.string().min(1),
  durationSec: z.number().positive(),
  moments: z.array(MomentSchema),
  characters: z.array(CharacterSchema),
  theme: ThemeSchema,
  /** The bar's start and beats; moves carry their own evals. */
  evalBar: EvalBarSchema.optional(),
  /** Portrait URLs by character id, loadable by the Player and the renderer. */
  portraits: z.record(z.string(), z.string()).optional(),
  /** Chess sound effects, shared by every theme. Without them the episode has only the source audio. */
  sounds: SoundBankSchema.optional(),
});
export type EpisodeProps = z.infer<typeof EpisodePropsSchema>;
