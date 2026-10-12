import { z } from 'zod';
import { MoveDraftSchema } from './analyst.ts';
import { EvalBarSchema } from './eval.ts';
import { AnalysisSchema, CharacterSchema, IngestSchema, MomentSchema, SourceSchema, UsageSchema } from './project.ts';

/** Containers the upload accepts. The proxy makes any of them browser-safe. */
export const UPLOAD_EXTENSIONS = ['mp4', 'mov', 'mkv'] as const;

/** Folder-relative path of a shot's filmstrip thumbnail. */
export const shotThumbnailFile = (shotIndex: number): string =>
  `frames/shot-${String(shotIndex).padStart(4, '0')}.jpg`;

/** Files inside a project folder that the server will serve. */
export const SERVABLE_FILE = /^(?:proxy\.mp4|source\.(?:mp4|mov|mkv)|frames\/shot-\d{4}\.jpg)$/;

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
