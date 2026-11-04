import {
  API_PREFIX,
  AnalysisConfigInfoSchema,
  ApiErrorBodySchema,
  CLIENT_VERSION,
  CLIENT_VERSION_HEADER,
  CreateProjectResultSchema,
  DownloadResultSchema,
  EvaluateResultSchema,
  HistoryEntrySchema,
  IDEMPOTENCY_HEADER,
  JobSchema,
  MeSchema,
  MediaGrantSchema,
  PortraitResultSchema,
  ProjectSchema,
  ProjectSummarySchema,
  ProjectUsageSchema,
  RegenerateResultSchema,
  RegionsResultSchema,
  RenderJobSchema,
  SaveResultSchema,
  SoundBankSchema,
  UploadPartsResultSchema,
  grantUrl,
  type AnalysisConfigInfo,
  type AnalyzeRequest,
  type ApiErrorBody,
  type ApiErrorCode,
  type EvaluateRequest,
  type EvaluateResult,
  type Format,
  type HistoryEntry,
  type Job,
  type MediaGrant,
  type Me,
  type Moment,
  type PortraitRequest,
  type Project,
  type ProjectEdit,
  type ProjectSummary,
  type ProjectUsage,
  type RegenerateResult,
  type RegionsResult,
  type RenderJob,
  type RenderRequest,
  type SoundBank,
  type UploadContext,
  type UploadedPart,
} from '@als/schema';
import { z } from 'zod';

/** An API error, with the contract's stable code to act on. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | undefined;
  readonly body: ApiErrorBody | undefined;

  constructor(status: number, body: ApiErrorBody | undefined, fallback: string) {
    super(body?.error ?? fallback);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

/** Key-value storage for resumable uploads (localStorage in a browser, Capacitor Preferences on a phone). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ClientOptions {
  /** The API's origin, e.g. `https://api.example.com`; empty for the page's own origin (the Vite proxy in dev). */
  origin?: string;
  /** Sent as `X-Client-Version`; an older client than the server accepts gets `client_too_old`. */
  clientVersion?: string;
  /** Where upload progress is kept so a dropped upload resumes. */
  storage?: KeyValueStore;
  /** Network retries per call, with the same idempotency key. */
  retries?: number;
}

export interface ProjectEventHandlers {
  /** A live job update, and every live job again on (re)connect. */
  job?: (job: Job) => void;
  /** The stream came back after a gap: jobs that finished meanwhile sent nothing, so refetch. */
  reconnect?: () => void;
}

/** The server pings every 5 s; a stream this quiet is dead. */
const EVENTS_STALE_MS = 12_000;
const EVENTS_RETRY_MS = 2_000;
/** Fetch new media URLs this long before the old ones expire. */
const GRANT_REFRESH_MS = 60 * 60 * 1000;

const UploadProgressSchema = z.object({
  projectId: z.string(),
  uploadId: z.string(),
  partSize: z.int().positive(),
  partCount: z.int().positive(),
  etags: z.record(z.string(), z.string()),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const newKey = () => crypto.randomUUID();

/**
 * The API client: the only code that calls the API. It adds the client
 * version, an Idempotency-Key per call (reused across its retries), signed
 * media URLs and resumable uploads, so the desktop editor and the mobile app
 * call the backend the same way.
 */
export function createApiClient(options: ClientOptions = {}) {
  const origin = (options.origin ?? '').replace(/\/$/, '');
  const clientVersion = options.clientVersion ?? CLIENT_VERSION;
  const retries = options.retries ?? 2;
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const grants = new Map<string, MediaGrant>();

  /** An absolute URL for an API path (the API hands out paths relative to its origin). */
  const absolute = (path: string) => `${origin}${path}`;

  async function send(method: string, path: string, init: { json?: unknown; key?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { [CLIENT_VERSION_HEADER]: clientVersion };
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    // One key per call, so its retries are the same intent.
    if (method !== 'GET') headers[IDEMPOTENCY_HEADER] = init.key ?? newKey();
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(absolute(`${API_PREFIX}${path}`), {
          method,
          headers,
          ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        });
      } catch (error) {
        // A network failure (the request may or may not have arrived): the same key makes repeating it safe.
        if (attempt >= retries) throw new Error(`could not reach the server (${(error as Error).message})`, { cause: error });
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  async function failure(res: Response, what: string): Promise<ApiRequestError> {
    const body = ApiErrorBodySchema.safeParse(await res.json().catch(() => undefined));
    return new ApiRequestError(res.status, body.success ? body.data : undefined, `${what} failed (${res.status})`);
  }

  async function request<T>(method: string, path: string, schema: z.ZodType<T>, init: { json?: unknown; key?: string } = {}): Promise<T> {
    const res = await send(method, path, init);
    if (!res.ok) throw await failure(res, `${method} ${path}`);
    return schema.parse(res.status === 204 ? undefined : await res.json());
  }

  const none = z.unknown();

  // Media: one grant per project signs every file of it.

  const remember = (projectId: string, grant: MediaGrant) => {
    grants.set(projectId, grant);
    return grant;
  };

  /** The project's media grant, fetched again when it is close to expiring. */
  async function loadMedia(projectId: string): Promise<MediaGrant> {
    const cached = grants.get(projectId);
    if (cached && Date.parse(cached.expiresAt) - Date.now() > GRANT_REFRESH_MS) return cached;
    return remember(projectId, await request('GET', `/projects/${projectId}/media`, MediaGrantSchema));
  }

  /** Throws away a project's grant, e.g. after playback failed with a 403, so the next load gets a fresh one. */
  const forgetMedia = (projectId: string) => grants.delete(projectId);

  /** URL of a file in a project, e.g. `proxy.mp4` or a shot thumbnail. Load the project's media first. */
  function fileUrl(projectId: string, file: string, version?: number): string {
    const grant = grants.get(projectId);
    if (!grant) return absolute(`${API_PREFIX}/projects/${projectId}/files/${file}`);
    return absolute(grantUrl(grant, file, version));
  }

  /** When the project's media URLs stop working. */
  const mediaExpiresAt = (projectId: string) => grants.get(projectId)?.expiresAt;

  // Live jobs: the dev event stream now, Realtime Broadcast in C3. The snapshot comes from GET /jobs on every (re)connect.

  function subscribeJobs(handlers: ProjectEventHandlers): () => void {
    let source: EventSource | undefined;
    let lastHeard = 0;
    let opened = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const snapshot = async () => {
      const jobs = await request('GET', '/jobs', JobSchema.array()).catch(() => []);
      if (!closed) for (const job of jobs) handlers.job?.(job);
    };

    const connect = () => {
      source?.close();
      lastHeard = Date.now();
      const current = new EventSource(absolute(`${API_PREFIX}/events`));
      source = current;
      const heard = () => {
        lastHeard = Date.now();
      };
      current.addEventListener('open', () => {
        heard();
        void snapshot();
        if (opened) handlers.reconnect?.();
        opened = true;
      });
      current.addEventListener('ping', heard);
      current.addEventListener('job', (e) => {
        heard();
        const parsed = JobSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
        if (parsed.success) handlers.job?.(parsed.data);
      });
      current.addEventListener('error', () => {
        // A 502 while the server restarts closes the stream for good; anything else EventSource retries itself.
        if (current.readyState === EventSource.CLOSED && current === source) {
          clearTimeout(retry);
          retry = setTimeout(connect, EVENTS_RETRY_MS);
        }
      });
    };

    connect();
    const watchdog = setInterval(() => {
      if (source && source.readyState !== EventSource.CLOSED && Date.now() - lastHeard > EVENTS_STALE_MS) connect();
    }, EVENTS_STALE_MS / 4);
    return () => {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(retry);
      source?.close();
    };
  }

  // Upload: create, then parts (resumable), then complete.

  const uploadSlot = (file: File) => `als-upload:${file.name}:${file.size}:${file.lastModified}`;

  /** PUTs one part with XHR (fetch cannot report upload progress) and returns its etag. */
  function putPart(url: string, body: Blob, onProgress: (loaded: number) => void): Promise<{ status: number; etag?: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', absolute(url));
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        const fromJson = (xhr.response as { etag?: string } | null)?.etag;
        resolve({ status: xhr.status, etag: xhr.getResponseHeader('ETag') ?? fromJson });
      };
      xhr.onerror = () => reject(new Error('upload failed: is the server running?'));
      xhr.send(body);
    });
  }

  /**
   * Uploads a clip and returns the new project. Progress is kept per file, so
   * choosing the same file after a dropped upload carries on from the parts already stored.
   */
  async function uploadClip(file: File, context: UploadContext, onProgress: (p: number) => void): Promise<Project> {
    const slot = uploadSlot(file);
    let progress = (() => {
      try {
        return UploadProgressSchema.parse(JSON.parse(storage?.getItem(slot) ?? 'null'));
      } catch {
        return undefined;
      }
    })();
    const save = () => progress && storage?.setItem(slot, JSON.stringify(progress));

    const askParts = async () => {
      if (!progress) throw new Error('no upload');
      const res = await send('POST', `/projects/${progress.projectId}/upload/parts`, { json: { uploadId: progress.uploadId } });
      if (res.status === 404) return undefined;
      if (!res.ok) throw await failure(res, 'upload');
      return UploadPartsResultSchema.parse(await res.json());
    };

    let parts = progress ? await askParts() : undefined;
    if (!parts) {
      // Nothing to resume (or the server no longer has it): start again.
      const created = await request('POST', '/projects', CreateProjectResultSchema, { json: { name: file.name, size: file.size, context } });
      progress = { projectId: created.projectId, ...created.upload, etags: {} };
      save();
      parts = (await askParts())!;
    }
    for (const part of parts.uploaded) progress!.etags[part.partNumber] = part.etag;
    save();

    const p = progress!;
    let done = Object.keys(p.etags).reduce((sum, n) => sum + Math.min(p.partSize, file.size - (Number(n) - 1) * p.partSize), 0);
    onProgress(done / file.size);
    for (let n = 1; n <= p.partCount; n++) {
      if (p.etags[n]) continue;
      const blob = file.slice((n - 1) * p.partSize, Math.min(n * p.partSize, file.size));
      for (let attempt = 0; ; attempt++) {
        const url = parts.parts.find((x) => x.partNumber === n)?.url;
        const result = url ? await putPart(url, blob, (loaded) => onProgress((done + loaded) / file.size)).catch(() => undefined) : undefined;
        if (result?.status === 200 && result.etag) {
          p.etags[n] = result.etag.replaceAll('"', '');
          break;
        }
        if (attempt >= 3) throw new Error(`upload failed on part ${n} of ${p.partCount}`);
        // An expired link (403) or a dropped connection: new URLs, then the same part again.
        await sleep(1000 * 2 ** attempt);
        parts = (await askParts()) ?? parts;
      }
      done += blob.size;
      save();
      onProgress(done / file.size);
    }

    const uploaded: UploadedPart[] = Object.entries(p.etags).map(([n, etag]) => ({ partNumber: Number(n), etag }));
    try {
      const project = await request('POST', `/projects/${p.projectId}/upload/complete`, ProjectSchema, { json: { uploadId: p.uploadId, parts: uploaded } });
      storage?.removeItem(slot);
      return project;
    } catch (error) {
      // A file that is not a video is gone on the server: forget it so the next try starts clean.
      if (error instanceof ApiRequestError && error.code !== 'upload_incomplete') storage?.removeItem(slot);
      throw error;
    }
  }

  return {
    origin,
    absolute,
    loadMedia,
    forgetMedia,
    fileUrl,
    mediaExpiresAt,
    subscribeJobs,
    uploadClip,

    getMe: (): Promise<Me> => request('GET', '/me', MeSchema),
    listJobs: (): Promise<Job[]> => request('GET', '/jobs', JobSchema.array()),

    async listProjects(): Promise<ProjectSummary[]> {
      const list = await request('GET', '/projects', ProjectSummarySchema.array());
      for (const p of list) if (p.media) remember(p.id, p.media);
      return list;
    },

    getProject: (id: string): Promise<Project> => request('GET', `/projects/${id}`, ProjectSchema),

    /** Autosave. A conflict means the project moved on since `edit.version`. */
    async saveProject(id: string, edit: ProjectEdit): Promise<{ kind: 'saved'; version: number } | { kind: 'conflict' }> {
      const res = await send('PUT', `/projects/${id}`, { json: edit });
      if (res.status === 409) return { kind: 'conflict' };
      if (!res.ok) throw await failure(res, 'save');
      return { kind: 'saved', version: SaveResultSchema.parse(await res.json()).version };
    },

    listHistory: (id: string): Promise<HistoryEntry[]> => request('GET', `/projects/${id}/history`, HistoryEntrySchema.array()),

    restoreVersion: (id: string, version: number, baseVersion: number) =>
      request('POST', `/projects/${id}/history/${version}/restore`, ProjectSchema, { json: { version: baseVersion } }),

    /** Re-runs ingest; returns the job (the running one if there is one). */
    rerunIngest: (id: string): Promise<Job> => request('POST', `/projects/${id}/ingest`, JobSchema),

    deleteProject: (id: string) => request('DELETE', `/projects/${id}`, none),

    /** The chess sounds the server has, with signed URLs; empty when there are none. */
    async getSoundBank(): Promise<SoundBank> {
      const bank = await request('GET', '/sounds', SoundBankSchema);
      return Object.fromEntries(Object.entries(bank).map(([id, sound]) => [id, { ...sound, src: absolute(sound.src) }]));
    },

    getAnalysisConfig: (): Promise<AnalysisConfigInfo> => request('GET', '/analysis/config', AnalysisConfigInfoSchema),

    /** Starts analysis; returns the job (the running one if there is one). */
    startAnalysis: (id: string, body: AnalyzeRequest = {}): Promise<Job> => request('POST', `/projects/${id}/analyze`, JobSchema, { json: body }),

    /** Faces and subject on a move's frozen frame; cached on the server per frame, so asking again is free. */
    findRegions: (id: string, moment: Moment): Promise<RegionsResult> => request('POST', `/projects/${id}/regions`, RegionsResultSchema, { json: { moment } }),

    /** Pass B for one moment; returns a proposal and saves nothing. */
    regenerateMoment: (id: string, moment: Moment, format: Format, instruction?: string): Promise<RegenerateResult> =>
      request('POST', `/projects/${id}/regenerate`, RegenerateResultSchema, { json: { moment, format, ...(instruction ? { instruction } : {}) } }),

    getUsage: (id: string): Promise<ProjectUsage> => request('GET', `/projects/${id}/usage`, ProjectUsageSchema),

    /** Pass C for the editor's track; returns a proposal for the whole bar and saves nothing. */
    evaluateTrack: (id: string, body: EvaluateRequest): Promise<EvaluateResult> => request('POST', `/projects/${id}/evaluate`, EvaluateResultSchema, { json: body }),

    /** Crops a portrait from one frame; returns its file. The project is not saved. */
    createPortrait: async (id: string, body: PortraitRequest): Promise<string> =>
      (await request('POST', `/projects/${id}/portraits`, PortraitResultSchema, { json: body })).file,

    /** Renders of a project, newest first. */
    listRenders: (id: string): Promise<RenderJob[]> => request('GET', `/projects/${id}/renders`, RenderJobSchema.array()),

    /** Starts a render of the version saved as `request.version`. A conflict means the project has a newer save. */
    async startRender(id: string, body: RenderRequest): Promise<{ kind: 'started'; render: RenderJob } | { kind: 'conflict' }> {
      const res = await send('POST', `/projects/${id}/renders`, { json: body });
      if (!res.ok) {
        const error = await failure(res, 'render');
        if (error.code === 'version_conflict') return { kind: 'conflict' };
        throw error;
      }
      return { kind: 'started', render: RenderJobSchema.parse(await res.json()) };
    },

    cancelRender: (id: string, render: string) => request('POST', `/projects/${id}/renders/${render}/cancel`, none),

    /** A signed URL that downloads the finished MP4. */
    downloadUrl: async (id: string, render: string): Promise<string> =>
      absolute((await request('GET', `/projects/${id}/renders/${render}/download`, DownloadResultSchema)).url),

    deleteRender: (id: string, render: string) => request('DELETE', `/projects/${id}/renders/${render}`, none),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
