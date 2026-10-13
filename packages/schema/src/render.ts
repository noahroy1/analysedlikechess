import { z } from 'zod';
import type { Source } from './project.ts';

/** Output size: the source's own, or scaled so its shorter side is a standard size (1080p vertical is 1080×1920). */
export const RENDER_PRESETS = ['source', '1080p', '2160p'] as const;
export const RenderPresetSchema = z.enum(RENDER_PRESETS);
export type RenderPreset = z.infer<typeof RenderPresetSchema>;

const PRESET_SHORT_SIDE: Record<Exclude<RenderPreset, 'source'>, number> = { '1080p': 1080, '2160p': 2160 };

/**
 * The scale and frame size a preset gives this source, or undefined when it
 * does not scale to whole, even dimensions (H.264 needs them).
 */
export function presetSize(source: Pick<Source, 'width' | 'height'>, preset: RenderPreset): { scale: number; width: number; height: number } | undefined {
  const scale = preset === 'source' ? 1 : PRESET_SHORT_SIDE[preset] / Math.min(source.width, source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  const even = (n: number) => Number.isInteger(n) && n % 2 === 0;
  return even(width) && even(height) ? { scale, width, height } : undefined;
}

/** Start a render of the project as saved at `version`. */
export const RenderRequestSchema = z.object({
  version: z.int().positive(),
  preset: RenderPresetSchema.default('source'),
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const RenderStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'cancelled']);
export type RenderStatus = z.infer<typeof RenderStatusSchema>;

/** One render of a project, listed in `renders/renders.json`. */
export const RenderJobSchema = z.object({
  /** `v<version>-<yyyymmdd>-<hhmmss>`; also the output's file name. */
  id: z.string().regex(/^v\d+-\d{8}-\d{6}$/),
  /** The saved version rendered; its snapshot is `renders/<id>.json`. */
  projectVersion: z.int().positive(),
  preset: RenderPresetSchema,
  width: z.int().positive(),
  height: z.int().positive(),
  fps: z.number().positive(),
  /** Output frames: the source plus every hold. */
  frames: z.int().positive(),
  status: RenderStatusSchema,
  /** What is happening now, e.g. "Bundling" or "Rendering frames". */
  stage: z.string().optional(),
  progress: z.number().min(0).max(1),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  /** Folder-relative output, written once the render succeeds. */
  file: z.string(),
  sizeBytes: z.int().nonnegative().optional(),
  error: z.string().optional(),
});
export type RenderJob = z.infer<typeof RenderJobSchema>;

/** Folder-relative output of a render. */
export const renderFile = (id: string) => `renders/${id}.mp4`;

/** Server-sent event: live state of a project's render. */
export const RenderEventSchema = z.object({
  projectId: z.string(),
  render: RenderJobSchema,
});
export type RenderEvent = z.infer<typeof RenderEventSchema>;
