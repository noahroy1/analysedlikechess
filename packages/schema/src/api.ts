import { z } from 'zod';
import { CharacterSchema, IngestSchema, MomentSchema, SourceSchema } from './project.ts';

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
