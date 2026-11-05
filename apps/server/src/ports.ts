import type {
  HistoryEntry,
  Job,
  JobKind,
  JobState,
  PortraitRequest,
  ProbeResult,
  Project,
  RenderEncoding,
  RenderJob,
  SoundBank,
  Shot,
  Source,
  UploadedPart,
  UploadRecord,
  UsageEntry,
  ProjectUsage,
} from '@als/schema';

// The seams between the API and where things live (PLAN-CLOUD.md, Phase C1).
// Each has a filesystem or in-process implementation under `node/` today; C3
// adds Supabase, R2, Workflows and Realtime ones. Nothing outside `node/` and
// `media/` touches the filesystem.

export class NotFoundError extends Error {}

/** A save based on a version that is no longer current. */
export class VersionConflictError extends Error {
  readonly current: number;

  constructor(current: number) {
    super(`project is at version ${current}`);
    this.current = current;
  }
}

/** The analysis "stage" whose output is the perception hints captured on the first run. */
export const HINTS_STAGE = 'hints';

/** Where a stage's cached output belongs. */
export type StageKind = 'ingest' | 'analysis' | 'regions';

export interface StageEntry {
  key: string;
  output: unknown;
}

/** Project documents, their history, stage caches, render lists and uploads in progress. */
export interface ProjectRepo {
  /** A readable, unique id based on `name`, reserved for a new project. */
  newId(name: string): Promise<string>;
  list(): Promise<Project[]>;
  read(id: string): Promise<Project>;
  create(project: Project): Promise<Project>;
  /** Read, change, validate and write back with `version` + 1. With `snapshot`, the current version goes into history first. */
  update(id: string, change: (project: Project) => Project | void, options?: { snapshot?: boolean }): Promise<Project>;
  /** An editor save: applies `change` only if the project is still at `baseVersion`, after putting the current version into history. */
  save(id: string, baseVersion: number, change: (project: Project) => Project | void): Promise<Project>;
  history(id: string): Promise<HistoryEntry[]>;
  readVersion(id: string, version: number): Promise<Project>;
  /** Deletes the project, its history, caches and every file. */
  remove(id: string): Promise<void>;

  getStage(projectId: string, kind: StageKind, stage: string): Promise<StageEntry | undefined>;
  putStage(projectId: string, kind: StageKind, stage: string, key: string, output: unknown): Promise<void>;

  /** A project's renders, oldest first. */
  renders(projectId: string): Promise<RenderJob[]>;
  /** Changes the render list in one step (no lost updates). */
  editRenders(projectId: string, change: (jobs: RenderJob[]) => void | Promise<void>): Promise<void>;

  getUpload(projectId: string): Promise<UploadRecord | undefined>;
  putUpload(upload: UploadRecord): Promise<void>;
  removeUpload(projectId: string): Promise<void>;
}

export interface BlobHead {
  size: number;
  /** Changes whenever the bytes change: a file's mtime, an R2 etag. */
  version: string;
}

export interface BlobRange {
  offset: number;
  length: number;
}

export interface BlobBody extends BlobHead {
  body: ReadableStream<Uint8Array>;
  /** Present when only part was asked for. */
  range?: BlobRange;
}

/**
 * Media files by key: `projects/<id>/<file>` (the project's folder-relative
 * names) and `sounds/<file>`. Ownership lives in the ProjectRepo, not in the key.
 */
export interface BlobStore {
  head(key: string): Promise<BlobHead | undefined>;
  get(key: string, range?: BlobRange): Promise<BlobBody | undefined>;
  /** The whole object as a Blob (lazy on disk), e.g. to upload to a provider. */
  blob(key: string, type?: string): Promise<Blob | undefined>;
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Deletes every key under a prefix ending in `/`. */
  deletePrefix(prefix: string): Promise<void>;

  createMultipart(key: string): Promise<string>;
  /** Stores one part (a repeat replaces it) and returns its etag. */
  uploadPart(key: string, uploadId: string, partNumber: number, body: ReadableStream<Uint8Array>): Promise<string>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export const projectKey = (projectId: string, file: string) => `projects/${projectId}/${file}`;
export const soundKey = (file: string) => `sounds/${file}`;

export interface JobContext<K extends JobKind> {
  job: Extract<Job, { kind: K }>;
  userId: string;
  request: unknown;
  /** Aborted when the job is cancelled. */
  signal: AbortSignal;
  /** Publishes the job's live state (throttled; status changes always go out). */
  report(state: JobState<K>): void;
  /**
   * One durable step of the job. On Node it just runs `work`. In a Workflow a
   * finished step is not run again when the job resumes (after a restart or a
   * deploy): its stored result is returned instead. Names are unique within a
   * job; results are JSON and small (Workflows keep at most 1 MiB a step), so
   * stages return what they need and keep their outputs in the stage cache.
   */
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
}

/** `JobContext.step` for code that runs outside a job too. */
export type Durable = <T>(name: string, work: () => Promise<T>) => Promise<T>;
export const runNow: Durable = (_name, work) => work();

export type JobHandler<K extends JobKind> = (context: JobContext<K>) => Promise<void>;

export interface StartJob<K extends JobKind> {
  userId: string;
  /** The state clients see until the job reports. */
  state: JobState<K>;
  request?: unknown;
}

/** Runs ingest, analysis and render jobs: at most one of a kind per project. */
export interface JobRunner {
  register<K extends JobKind>(kind: K, handler: JobHandler<K>): void;
  /** Starts a job, or returns the one of this kind already pending or running for the project (`created: false`). */
  start<K extends JobKind>(kind: K, projectId: string, start: StartJob<K>): Promise<{ job: Extract<Job, { kind: K }>; created: boolean }>;
  /** The pending or running job of this kind for the project. */
  find<K extends JobKind>(kind: K, projectId: string): Promise<Extract<Job, { kind: K }> | undefined>;
  /** Every pending or running job of a user, for clients that just connected. */
  list(userId: string): Promise<Job[]>;
  /** Stops a pending job before it starts, or aborts a running one. False if it is not live. */
  cancel(jobId: string): Promise<boolean>;
  /** Resolves once nothing is pending or running (tests and shutdown). */
  whenIdle(): Promise<void>;
}

/** Live job updates to a user's clients. */
export interface EventBus {
  publish(userId: string, job: Job): void;
}

/** The chess sounds every project shares (Node: a folder; C3: the `sounds` table and R2). */
export interface SoundSource {
  /** The bank, with each file's URL from `src` (signed by the caller). */
  bank(src: (file: string) => string): Promise<SoundBank>;
}

/** What only an admin changes about a user. */
export interface Profile {
  role: 'user' | 'admin';
  /** Absent: the default cap (DEFAULT_MONTHLY_CAP_USD). */
  monthlyCapUsd?: number;
}

/** Users' profiles (C3: `app.profiles`; on Node the one local user is an admin). */
export interface ProfileStore {
  get(userId: string): Promise<Profile>;
}

/** One paid call's spend, per user and project. */
export interface UsageLog {
  record(entry: Omit<UsageEntry, 'at'> & { at?: string }): Promise<void>;
  /** Spend since the start of the month containing `now` (UTC). */
  monthToDate(userId: string, now?: Date): Promise<number>;
  /** The editor's own AI calls on one project. */
  projectTotals(projectId: string): Promise<ProjectUsage>;
}

export type { ProbeResult };

/** A file in a project and where it goes. */
export interface MediaFile {
  projectId: string;
  file: string;
}

export interface MediaProgress {
  progress: number;
  stage?: string;
}

export interface RenderChunkInput {
  projectId: string;
  /** `<Episode>` props, every URL absolute; the media service fetches them first. */
  props: unknown;
  scale: number;
  /** Output frames [from, to], inclusive. */
  frameRange: [number, number];
  encoding: RenderEncoding;
  /** Folder-relative outputs: the H.264 transport stream and its AAC audio. */
  video: string;
  audio: string;
  /** How many chunks of this render run at once. */
  chunks: number;
  onProgress: (progress: MediaProgress) => void;
  signal: AbortSignal;
}

export interface CombineInput {
  projectId: string;
  /** Folder-relative chunk files, in order. */
  videos: string[];
  audios: string[];
  /** Folder-relative MP4. */
  output: string;
  fps: number;
  framesPerChunk: number;
  durationInFrames: number;
  encoding: RenderEncoding;
  onProgress: (progress: MediaProgress) => void;
  signal: AbortSignal;
}

/**
 * ffmpeg and Remotion: the media service (`apps/media`), a local process on
 * Node and a Container in the cloud. Each call reads its inputs from the
 * project's files and writes outputs beside them.
 */
export interface MediaRunner {
  /** Reads the video's size, rate, length and audio. Throws NotAVideoError for anything else. */
  probe(input: MediaFile): Promise<ProbeResult>;
  hash(input: MediaFile, onProgress: (p: number) => void): Promise<string>;
  /** The 720p proxy, frame for frame with the source. */
  proxy(input: MediaFile & { output: string; fps: number; durationSec: number }, onProgress: (p: number) => void): Promise<void>;
  /** Mono 16 kHz WAV for speech-to-text. */
  audio(input: MediaFile & { output: string; durationSec: number }, onProgress: (p: number) => void): Promise<void>;
  /** Cut detection on the proxy. */
  shots(input: MediaFile & { durationSec: number }, onProgress: (p: number) => void): Promise<Shot[]>;
  /** One thumbnail per shot, replacing the old set. */
  thumbnails(input: MediaFile & { shots: Shot[] }, onProgress: (p: number) => void): Promise<void>;
  /** One frame (same frame numbers as the source) as a JPEG. */
  frame(input: MediaFile & { frame: number; fps: number }): Promise<Uint8Array>;
  /** Crops a square portrait from one frame into `output`. */
  portrait(input: MediaFile & { output: string; request: PortraitRequest; source: Pick<Source, 'width' | 'height' | 'durationSec'> }): Promise<void>;
  /** Renders a range of an episode's frames, for `combine`. Returns the seconds it ran (what a container bills). */
  renderChunk(input: RenderChunkInput): Promise<{ seconds: number }>;
  /** Joins rendered chunks into the MP4. */
  combine(input: CombineInput): Promise<{ sizeBytes: number; seconds: number }>;
  /** Gets the browser and bundle ready ahead of the first render. */
  warmUp(): void;
}

/** A video the probe could not read. */
export class NotAVideoError extends Error {}

/** A paid call refused because the user's month-to-date spend reached their cap. */
export class OverCapError extends Error {}

/** A job of this kind is already running for the project, and it is not the one asked for. */
export class JobRunningError extends Error {
  readonly job: Job;

  constructor(message: string, job: Job) {
    super(message);
    this.job = job;
  }
}

/** The project is not in a state that allows this yet (e.g. analysis before ingest finished). */
export class NotReadyError extends Error {}

/** An upload's parts are missing or do not match what was stored. */
export class UploadIncompleteError extends Error {}
