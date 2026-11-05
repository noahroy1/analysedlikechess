import { z } from 'zod';
import { AnalysisSchema, IngestSchema, UsageSchema } from './project.ts';
import { RenderJobSchema } from './render.ts';

// The v1 API contract (PLAN-CLOUD.md, "API contract"): what every route under
// /api/v1 promises, so a client written once keeps working on the Node server
// and later on the Worker.

/** Every route lives under this prefix. Within v1, changes only add things. */
export const API_PREFIX = '/api/v1';

/** The version this code's client sends in `X-Client-Version`. */
export const CLIENT_VERSION = '1.0.0';
/** Older clients get 426 `client_too_old`. Store builds update slower than the desktop, so raise it only when an old client would break. */
export const MIN_CLIENT_VERSION = '1.0.0';

/** True when `version` ("major.minor.patch") is at least `min`. Anything unparseable is too old. */
export function clientVersionOk(version: string, min = MIN_CLIENT_VERSION): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : undefined);
  const [have, need] = [parse(version), parse(min)];
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  return true;
}

/** Stable error codes: clients act on these, never on the message. */
export const API_ERROR_CODES = [
  'invalid_request',
  /** No valid sign-in token (401): sign in again. */
  'unauthorized',
  'not_found',
  'version_conflict',
  'job_running',
  'not_ready',
  'over_cap',
  'missing_keys',
  'provider_error',
  'render_preset',
  'upload_incomplete',
  'not_a_video',
  'media_url_invalid',
  'client_too_old',
  'idempotency_key_required',
  'idempotency_key_reused',
  'internal',
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Every error body. `current` comes with `version_conflict`; `job` with `job_running`. */
export const ApiErrorBodySchema = z.object({
  error: z.string(),
  code: ApiErrorCodeSchema,
  current: z.int().nonnegative().optional(),
  job: z.lazy(() => JobSchema).optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** Header carrying the key that makes a POST, PUT or DELETE safe to repeat. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** Set on a response replayed from an earlier call with the same key. */
export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replayed';
export const CLIENT_VERSION_HEADER = 'X-Client-Version';
/** How long a key is remembered. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IdempotencyKeySchema = z.string().min(8).max(200);

// Jobs: ingest, analysis and render, one at a time per project and kind.

export const JOB_KINDS = ['ingest', 'analysis', 'render'] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

const jobBase = { id: z.string().min(1), projectId: z.string().min(1) };
/** A live job and its state. `GET /jobs` lists them; live updates carry the same shape. */
export const JobSchema = z.discriminatedUnion('kind', [
  z.object({ ...jobBase, kind: z.literal('ingest'), state: IngestSchema }),
  z.object({ ...jobBase, kind: z.literal('analysis'), state: AnalysisSchema }),
  z.object({ ...jobBase, kind: z.literal('render'), state: RenderJobSchema }),
]);
export type Job = z.infer<typeof JobSchema>;
export type JobOf<K extends JobKind> = Extract<Job, { kind: K }>;
export type JobState<K extends JobKind> = JobOf<K>['state'];

// Spend.

/** Per-user monthly cap on paid calls, in US dollars: the one place the value lives (Nov 3: start at $2, tighten later). */
export const DEFAULT_MONTHLY_CAP_USD = 2;

/** One paid call, for the month-to-date total and per-project totals. */
export const UsageEntrySchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  /** e.g. `analysis.annotate`, `regenerate`, `evaluate`, `regions`, `render`. */
  call: z.string(),
  model: z.string().optional(),
  usage: UsageSchema.optional(),
  costUsd: z.number().nonnegative(),
  containerSec: z.number().nonnegative().optional(),
  at: z.iso.datetime(),
});
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

/** The editor's own AI calls, totalled per project. */
export const EDITOR_CALLS = ['regenerate', 'evaluate', 'regions'] as const;
export type EditorCall = (typeof EDITOR_CALLS)[number];
export const CallTotalSchema = z.object({ count: z.int().nonnegative(), costUsd: z.number().nonnegative() });
export const ProjectUsageSchema = z.object({ regenerate: CallTotalSchema, evaluate: CallTotalSchema, regions: CallTotalSchema });
export type ProjectUsage = z.infer<typeof ProjectUsageSchema>;

/** `GET /me`: who is signed in and how much of this month's cap is spent. */
export const MeSchema = z.object({
  user: z.object({ id: z.string() }),
  role: z.enum(['user', 'admin']),
  monthlyCapUsd: z.number().nonnegative(),
  monthToDateUsd: z.number().nonnegative(),
});
export type Me = z.infer<typeof MeSchema>;

/** `GET /analysis/config`. */
export const AnalysisConfigInfoSchema = z.object({
  missingKeys: z.array(z.string()),
  models: z.record(z.string(), z.string()),
  autoAnalyze: z.boolean(),
  replay: z.boolean(),
});
export type AnalysisConfigInfo = z.infer<typeof AnalysisConfigInfoSchema>;

// Upload: create, then parts, then complete.

/** Containers the upload accepts. The proxy makes any of them browser-safe. */
export const UPLOAD_EXTENSIONS = ['mp4', 'mov', 'mkv'] as const;

/** Every part but the last is this size (R2 needs equal parts; small enough to retry on a phone). */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
/** R2 allows 10,000 parts per upload. */
export const MAX_UPLOAD_PARTS = 10_000;

export const UploadContextSchema = z.object({
  movieTitle: z.string().trim().max(200).optional(),
  sceneNote: z.string().trim().max(500).optional(),
  /** Names typed at upload; they guide speaker naming and transcription spelling. */
  characters: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
});
export type UploadContext = z.infer<typeof UploadContextSchema>;

const uploadName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => (UPLOAD_EXTENSIONS as readonly string[]).includes(name.split('.').pop()?.toLowerCase() ?? ''), {
    message: `upload an ${UPLOAD_EXTENSIONS.join(', ').toUpperCase()} file`,
  });

/** `POST /projects`: the file's name and size, and what the creator typed about it. */
export const CreateProjectRequestSchema = z.object({
  name: uploadName,
  size: z.int().positive().max(UPLOAD_PART_BYTES * MAX_UPLOAD_PARTS),
  context: UploadContextSchema.default({}),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/** An upload in progress, kept until it completes. The project exists only once the file is probed. */
export const UploadRecordSchema = z.object({
  projectId: z.string(),
  uploadId: z.string(),
  /** Folder-relative name the source is stored under, e.g. `source.mov`. */
  file: z.string(),
  originalName: z.string(),
  size: z.int().positive(),
  partSize: z.int().positive(),
  partCount: z.int().positive(),
  context: UploadContextSchema,
  createdAt: z.iso.datetime(),
});
export type UploadRecord = z.infer<typeof UploadRecordSchema>;

export const UploadInfoSchema = UploadRecordSchema.pick({ uploadId: true, partSize: true, partCount: true });
export type UploadInfo = z.infer<typeof UploadInfoSchema>;

export const CreateProjectResultSchema = z.object({ projectId: z.string(), upload: UploadInfoSchema });
export type CreateProjectResult = z.infer<typeof CreateProjectResultSchema>;

/** `POST /projects/:id/upload/parts`: URLs for these parts (all of them when absent). Safe to ask again, e.g. to resume. */
export const UploadPartsRequestSchema = z.object({
  uploadId: z.string(),
  partNumbers: z.array(z.int().positive()).max(MAX_UPLOAD_PARTS).optional(),
});
export const UploadedPartSchema = z.object({ partNumber: z.int().positive(), etag: z.string() });
export type UploadedPart = z.infer<typeof UploadedPartSchema>;
export const UploadPartsResultSchema = z.object({
  /** PUT each part's bytes to its URL; the response's `ETag` header (or `etag` in its JSON) goes into complete. */
  parts: z.array(z.object({ partNumber: z.int().positive(), url: z.string() })),
  /** Parts already stored, so a resumed upload skips them. */
  uploaded: z.array(UploadedPartSchema),
  expiresAt: z.iso.datetime(),
});
export type UploadPartsResult = z.infer<typeof UploadPartsResultSchema>;

export const CompleteUploadRequestSchema = z.object({ uploadId: z.string(), parts: z.array(UploadedPartSchema).min(1) });
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequestSchema>;

// Media URLs.

/** How long a signed media URL works. Clients fetch fresh ones when playback fails with a 403. */
export const MEDIA_URL_TTL_SEC = 6 * 60 * 60;

/**
 * `GET /projects/:id/media`: one signature for every file of a project. A
 * file's URL is `${base}${file}?${query}` (or `&${query}` after the file's own query).
 */
export const MediaGrantSchema = z.object({ base: z.string(), query: z.string(), expiresAt: z.iso.datetime() });
export type MediaGrant = z.infer<typeof MediaGrantSchema>;

/** The URL of a project file under a grant, with an optional cache-busting `v`. */
export function grantUrl(grant: MediaGrant, file: string, version?: number): string {
  return `${grant.base}${file}?${version === undefined ? '' : `v=${version}&`}${grant.query}`;
}

/** `GET /projects/:id/renders/:render/download`: a signed URL that downloads the MP4 as an attachment. */
export const DownloadResultSchema = z.object({ url: z.string(), expiresAt: z.iso.datetime() });
