import { z } from 'zod';
import { CharacterSchema, MomentSchema } from './project.ts';
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
});
export type EpisodeProps = z.infer<typeof EpisodePropsSchema>;
