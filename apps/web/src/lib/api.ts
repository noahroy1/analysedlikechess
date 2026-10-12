import {
  AnalysisEventSchema,
  ApiErrorSchema,
  EvaluateResultSchema,
  HistoryEntrySchema,
  PortraitResultSchema,
  RegenerateResultSchema,
  RenderEventSchema,
  RenderJobSchema,
  SoundBankSchema,
  SaveResultSchema,
  type AnalysisEvent,
  type AnalyzeRequest,
  type EvaluateRequest,
  type EvaluateResult,
  type Moment,
  type PortraitRequest,
  type RegenerateResult,
  type RenderEvent,
  type RenderJob,
  type RenderRequest,
  type SoundBank,
  type HistoryEntry,
  type ProjectEdit,
  IngestEventSchema,
  ProjectSchema,
  ProjectSummarySchema,
  type IngestEvent,
  type Project,
  type ProjectSummary,
} from '@als/schema';

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`/api${path}`, init);
  if (res.status === 204) return undefined;
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `request failed (${res.status})`);
  }
  return body;
}

export const listProjects = async (): Promise<ProjectSummary[]> =>
  ProjectSummarySchema.array().parse(await request('/projects'));

export const getProject = async (id: string): Promise<Project> =>
  ProjectSchema.parse(await request(`/projects/${id}`));

/** Autosave. A 409 means the project moved on since `edit.version`. */
export async function saveProject(id: string, edit: ProjectEdit): Promise<{ kind: 'saved'; version: number } | { kind: 'conflict' }> {
  const res = await fetch(`/api/projects/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
  });
  if (res.status === 409) return { kind: 'conflict' };
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `save failed (${res.status})`);
  }
  return { kind: 'saved', version: SaveResultSchema.parse(body).version };
}

export const listHistory = async (id: string): Promise<HistoryEntry[]> =>
  HistoryEntrySchema.array().parse(await request(`/projects/${id}/history`));

export const restoreVersion = (id: string, version: number, baseVersion: number) =>
  request(`/projects/${id}/history/${version}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: baseVersion }),
  });

export const rerunIngest = (id: string) => request(`/projects/${id}/ingest`, { method: 'POST' });

export const deleteProject = (id: string) => request(`/projects/${id}`, { method: 'DELETE' });

/** The chess sounds the server has (files in `media/sounds`); empty when there are none. */
export const getSoundBank = async (): Promise<SoundBank> => SoundBankSchema.parse(await request('/sounds'));

/** URL of a file inside a project folder, e.g. `proxy.mp4` or a shot thumbnail. */
export const fileUrl = (id: string, file: string, version?: number) =>
  `/api/projects/${id}/files/${file}${version === undefined ? '' : `?v=${version}`}`;

export interface UploadContext {
  movieTitle?: string;
  sceneNote?: string;
  /** Comma-separated names; they guide speaker naming and transcription. */
  characters?: string;
}

/** Streams the file to the server as the raw request body, reporting 0-1 progress. */
export function uploadClip(file: File, context: UploadContext, onProgress: (p: number) => void): Promise<Project> {
  const params = new URLSearchParams({ name: file.name });
  if (context.movieTitle) params.set('movieTitle', context.movieTitle);
  if (context.sceneNote) params.set('sceneNote', context.sceneNote);
  if (context.characters) params.set('characters', context.characters);

  // XHR rather than fetch: fetch cannot report upload progress.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects?${params}`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 201) {
        resolve(ProjectSchema.parse(xhr.response));
      } else {
        const parsed = ApiErrorSchema.safeParse(xhr.response);
        reject(new Error(parsed.success ? parsed.data.error : `upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('upload failed: is the server running?'));
    xhr.send(file);
  });
}

export interface ProjectEventHandlers {
  ingest?: (event: IngestEvent) => void;
  analysis?: (event: AnalysisEvent) => void;
  render?: (event: RenderEvent) => void;
}

/** Subscribes to live ingest, analysis and render progress for every project. Returns an unsubscribe function. */
export function subscribeProjectEvents(handlers: ProjectEventHandlers): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('ingest', (e) => {
    const parsed = IngestEventSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
    if (parsed.success) handlers.ingest?.(parsed.data);
  });
  source.addEventListener('analysis', (e) => {
    const parsed = AnalysisEventSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
    if (parsed.success) handlers.analysis?.(parsed.data);
  });
  source.addEventListener('render', (e) => {
    const parsed = RenderEventSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
    if (parsed.success) handlers.render?.(parsed.data);
  });
  return () => source.close();
}

export interface AnalysisConfigInfo {
  missingKeys: string[];
  models: Record<string, string>;
  autoAnalyze: boolean;
  replay: boolean;
}

export const getAnalysisConfig = async () => (await request('/analysis/config')) as AnalysisConfigInfo;

export const startAnalysis = (id: string, body: AnalyzeRequest = {}) =>
  request(`/projects/${id}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Pass B for one moment; returns a proposal and saves nothing. */
export const regenerateMoment = async (id: string, moment: Moment, instruction?: string): Promise<RegenerateResult> =>
  RegenerateResultSchema.parse(
    await request(`/projects/${id}/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moment, ...(instruction ? { instruction } : {}) }),
    }),
  );

export const getUsage = async (id: string) =>
  (await request(`/projects/${id}/usage`)) as Record<'regenerate' | 'evaluate', { count: number; costUsd: number }>;

/** Pass C for the editor's track; returns a proposal for the whole bar and saves nothing. */
export const evaluateTrack = async (id: string, body: EvaluateRequest): Promise<EvaluateResult> =>
  EvaluateResultSchema.parse(
    await request(`/projects/${id}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

/** Crops a portrait from one frame; returns its file. The project is not saved. */
export const createPortrait = async (id: string, body: PortraitRequest): Promise<string> =>
  PortraitResultSchema.parse(
    await request(`/projects/${id}/portraits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  ).file;

/** Renders of a project, newest first. */
export const listRenders = async (id: string): Promise<RenderJob[]> => RenderJobSchema.array().parse(await request(`/projects/${id}/renders`));

/** Starts a render of the version saved as `request.version`. A 409 means the project has a newer save. */
export async function startRender(id: string, body: RenderRequest): Promise<{ kind: 'started'; render: RenderJob } | { kind: 'conflict' }> {
  const res = await fetch(`/api/projects/${id}/renders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (res.status === 409 && json && typeof json === 'object' && 'current' in json) return { kind: 'conflict' };
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    throw new Error(parsed.success ? parsed.data.error : `render failed to start (${res.status})`);
  }
  return { kind: 'started', render: RenderJobSchema.parse(json) };
}

export const cancelRender = (id: string, render: string) => request(`/projects/${id}/renders/${render}/cancel`, { method: 'POST' });

/** Shows the MP4 in Finder. */
export const revealRender = (id: string, render: string) => request(`/projects/${id}/renders/${render}/reveal`, { method: 'POST' });

export const deleteRender = (id: string, render: string) => request(`/projects/${id}/renders/${render}`, { method: 'DELETE' });
