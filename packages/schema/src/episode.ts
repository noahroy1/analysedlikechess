import { z } from 'zod';
import { EvalBarSchema } from './eval.ts';
import { CharacterSchema, EvalBarScaleSchema, MomentSchema, type Character, type Project } from './project.ts';
import { SoundBankSchema, type SoundBank } from './sounds.ts';
import { SubtitleSchema, subtitlesFromTranscript } from './subtitles.ts';
import { ThemeSchema, type Theme } from './theme.ts';

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
  /** The bar's size; absent is 100%. */
  evalBarScale: EvalBarScaleSchema.optional(),
  /** Portrait URLs by character id, loadable by the Player and the renderer. */
  portraits: z.record(z.string(), z.string()).optional(),
  /** Chess sound effects, shared by every theme. Without them the episode has only the source audio. */
  sounds: SoundBankSchema.optional(),
  /** Lines of dialogue, drawn in the theme's subtitle style. */
  subtitles: z.array(SubtitleSchema).optional(),
});
export type EpisodeProps = z.infer<typeof EpisodePropsSchema>;

/** The parts of a project (or of the editor's unsaved document) an episode is drawn from. */
export type EpisodeDoc = Pick<Project, 'moments' | 'evalBar' | 'evalBarScale' | 'subtitles' | 'transcript'> & {
  characters: Character[];
  durationSec: number;
};

export interface EpisodeMedia {
  /** The clip: the proxy in the Player, the original source when rendering. */
  src: string;
  theme: Theme;
  /** URL of a file in the project folder (portraits). */
  fileUrl: (file: string) => string;
  sounds?: SoundBank | undefined;
}

/**
 * The one way a document becomes episode props, so the Player and the
 * renderer draw from the same data. Subtitles that were never edited follow the transcript.
 */
export const episodeProps = (doc: EpisodeDoc, media: EpisodeMedia): EpisodeProps => ({
  src: media.src,
  durationSec: doc.durationSec,
  moments: doc.moments,
  characters: doc.characters,
  theme: media.theme,
  ...(doc.evalBar ? { evalBar: doc.evalBar } : {}),
  ...(doc.evalBarScale ? { evalBarScale: doc.evalBarScale } : {}),
  portraits: Object.fromEntries(doc.characters.flatMap((c) => (c.portrait ? [[c.id, media.fileUrl(c.portrait)]] : []))),
  ...(media.sounds ? { sounds: media.sounds } : {}),
  subtitles: doc.subtitles ?? subtitlesFromTranscript(doc.transcript),
});

/** What the renderer's composition receives: the episode plus the frame it is drawn at. */
export const RenderPropsSchema = EpisodePropsSchema.extend({
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type RenderProps = z.infer<typeof RenderPropsSchema>;
