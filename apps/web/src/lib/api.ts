import {
  ApiErrorSchema,
  HistoryEntrySchema,
  SaveResultSchema,
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

/** URL of a file inside a project folder, e.g. `proxy.mp4` or a shot thumbnail. */
export const fileUrl = (id: string, file: string, version?: number) =>
  `/api/projects/${id}/files/${file}${version === undefined ? '' : `?v=${version}`}`;

export interface UploadContext {
  movieTitle?: string;
  sceneNote?: string;
}

/** Streams the file to the server as the raw request body, reporting 0-1 progress. */
export function uploadClip(file: File, context: UploadContext, onProgress: (p: number) => void): Promise<Project> {
  const params = new URLSearchParams({ name: file.name });
  if (context.movieTitle) params.set('movieTitle', context.movieTitle);
  if (context.sceneNote) params.set('sceneNote', context.sceneNote);

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

/** Subscribes to live ingest progress for every project. Returns an unsubscribe function. */
export function subscribeIngest(onEvent: (event: IngestEvent) => void): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('ingest', (e) => {
    const parsed = IngestEventSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
    if (parsed.success) onEvent(parsed.data);
  });
  return () => source.close();
}
