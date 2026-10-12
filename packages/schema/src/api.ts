import { z } from 'zod';
import { MoveDraftSchema } from './analyst.ts';
import { EvalBarSchema, EvalSchema } from './eval.ts';
import { AnalysisSchema, CharacterSchema, IngestSchema, MomentSchema, SourceSchema, UsageSchema } from './project.ts';
import { FrameRegionsSchema } from './regions.ts';
import { SubtitleSchema } from './subtitles.ts';

/** Containers the upload accepts. The proxy makes any of them browser-safe. */
export const UPLOAD_EXTENSIONS = ['mp4', 'mov', 'mkv'] as const;

/** Folder-relative path of a shot's filmstrip thumbnail. */
export const shotThumbnailFile = (shotIndex: number): string =>
  `frames/shot-${String(shotIndex).padStart(4, '0')}.jpg`;

/** Files inside a project folder that the server will serve. */
export const SERVABLE_FILE = /^(?:proxy\.mp4|source\.(?:mp4|mov|mkv)|frames\/shot-\d{4}\.jpg|portraits\/[a-z0-9-]+\.jpg|renders\/v\d+-\d{8}-\d{6}\.mp4)$/;

const Unit = z.number().min(0).max(1);

/**
 * Crop a character's portrait from one frame of the clip: a square whose
 * top-left corner is at (x, y), as fractions of the frame's width and height,
 * and whose side is `size` of the frame's height.
 */
export const PortraitRequestSchema = z.object({
  characterId: z.string().min(1),
  sourceTime: z.number().nonnegative(),
  x: Unit,
  y: Unit,
  size: z.number().positive().max(1),
});
export type PortraitRequest = z.infer<typeof PortraitRequestSchema>;

/** The new still's folder-relative file; nothing else is saved, so the editor sets it on the character. */
export const PortraitResultSchema = z.object({ file: z.string() });

export const ProjectSummarySchema = z.object({
  id: z.string(),
  version: z.int().nonnegative(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  source: SourceSchema,
  ingest: IngestSchema,
  analysis: AnalysisSchema,
  shotCount: z.int().nonnegative(),
  momentCount: z.int().nonnegative(),
  /** Folder-relative thumbnail for list views, once shots exist. */
  poster: z.string().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/** Server-sent event: live state of a project's ingest job. */
export const IngestEventSchema = z.object({
  projectId: z.string(),
  ingest: IngestSchema,
});
export type IngestEvent = z.infer<typeof IngestEventSchema>;

/** Server-sent event: live state of a project's analysis job. */
export const AnalysisEventSchema = z.object({
  projectId: z.string(),
  analysis: AnalysisSchema,
});
export type AnalysisEvent = z.infer<typeof AnalysisEventSchema>;

/** Start analysis. `rerun: 'analyst'` re-drafts with the cached transcript and scene notes. */
export const AnalyzeRequestSchema = z.object({
  rerun: z.enum(['analyst', 'all']).optional(),
  secondsPerMove: z.number().positive().optional(),
});
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

/** Regenerate one moment's text (Pass B alone). The moment may not be saved yet. */
export const RegenerateRequestSchema = z.object({
  moment: MomentSchema,
  instruction: z.string().max(500).optional(),
});
export type RegenerateRequest = z.infer<typeof RegenerateRequestSchema>;

export const RegenerateResultSchema = z.object({
  draft: MoveDraftSchema,
  model: z.string(),
  usage: UsageSchema,
  costUsd: z.number().nonnegative(),
});
export type RegenerateResult = z.infer<typeof RegenerateResultSchema>;

/** Find the faces and subject on a move's frozen frame, for placing its card. Saves nothing. */
export const RegionsRequestSchema = z.object({ moment: MomentSchema });
export type RegionsRequest = z.infer<typeof RegionsRequestSchema>;

export const RegionsResultSchema = z.object({
  regions: FrameRegionsSchema,
  model: z.string(),
  usage: UsageSchema,
  /** 0 when the frame was already looked at with the same prompt. */
  costUsd: z.number().nonnegative(),
});
export type RegionsResult = z.infer<typeof RegionsResultSchema>;

/**
 * Re-evaluate the bar (Pass C alone) for the editor's current track. Without
 * an `evalBar`, beats are placed from the last analysis's candidates.
 */
export const EvaluateRequestSchema = z.object({
  moments: z.array(MomentSchema),
  characters: z.array(CharacterSchema),
  evalBar: EvalBarSchema.optional(),
});
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;

/** A proposal for the whole bar: nothing is saved until the editor applies it. */
export const EvaluateResultSchema = z.object({
  evalBar: EvalBarSchema,
  /** Each move's new eval, by moment id. */
  evals: z.record(z.string(), EvalSchema),
  /** Values the rules changed, with why. */
  adjusted: z.array(z.object({ id: z.string(), reason: z.string() })),
  model: z.string(),
  usage: UsageSchema,
  costUsd: z.number().nonnegative(),
});
export type EvaluateResult = z.infer<typeof EvaluateResultSchema>;

export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Editor autosave: the parts of a project the editor changes, plus the
 * version they are based on. A stale version gets a 409.
 */
export const ProjectEditSchema = z.object({
  version: z.int().nonnegative(),
  moments: z.array(MomentSchema),
  characters: z.array(CharacterSchema),
  themeId: z.string().min(1),
  /** Omitted until the project has a bar; once set it is always sent. */
  evalBar: EvalBarSchema.optional(),
  /** Omitted while the subtitles follow the transcript. */
  subtitles: z.array(SubtitleSchema).optional(),
});
export type ProjectEdit = z.infer<typeof ProjectEditSchema>;

export const SaveResultSchema = z.object({ version: z.int().nonnegative() });

export const ConflictSchema = z.object({ error: z.string(), current: z.int().nonnegative() });

export const HistoryEntrySchema = z.object({
  version: z.int().nonnegative(),
  savedAt: z.iso.datetime(),
  momentCount: z.int().nonnegative(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
