import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PREFIX, IDEMPOTENCY_HEADER } from '@als/schema';
import { loadAnalysisConfig, type AnalysisConfig } from './analysis/config.ts';
import type { Providers } from './analysis/providers/index.ts';
import { createNodeServer, type NodeServerOptions } from './node/server.ts';

/** Recorded provider responses for the dialogue fixture; tests never call cloud APIs. */
export const DIALOGUE_RECORDING = fileURLToPath(new URL('../../../fixtures/dialogue/recorded', import.meta.url));

export const TEST_MEDIA_SECRET = 'test-media-url-secret-0123456789abcdef';

/**
 * The whole server against a scratch projects folder, with replayed providers.
 * Renders load media from `origin`, which only a test that serves the app sets.
 */
export async function makeTestApp(
  root: string,
  overrides: Partial<AnalysisConfig> = {},
  soundsDir = join(root, 'sounds'),
  origin = 'http://127.0.0.1:0',
  options: { capUsd?: number; providers?: Providers; wrapMedia?: NodeServerOptions['wrapMedia'] } = {},
) {
  const config: AnalysisConfig = { ...loadAnalysisConfig({}), autoAnalyze: false, replayDir: DIALOGUE_RECORDING, ...overrides };
  const server = await createNodeServer({ projectsDir: root, soundsDir, config, origin, mediaSecret: TEST_MEDIA_SECRET, ...options });
  let n = 0;
  /**
   * A v1 request: the path is under /api/v1, JSON bodies are encoded, and every
   * POST, PUT and DELETE gets a fresh Idempotency-Key unless one is given.
   */
  const call = (path: string, init: { method?: string; json?: unknown; body?: RequestInit['body']; headers?: Record<string, string>; key?: string } = {}) => {
    const method = init.method ?? (init.json !== undefined ? 'POST' : 'GET');
    const headers: Record<string, string> = { ...init.headers };
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD' && !(IDEMPOTENCY_HEADER in headers)) headers[IDEMPOTENCY_HEADER] = init.key ?? `test-key-${++n}-${Date.now()}`;
    return server.app.request(`${API_PREFIX}${path}`, {
      method,
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body !== undefined ? { body: init.body } : {}),
    });
  };
  /** A project's folder on disk, for tests that look at files. */
  const dir = (id: string) => join(root, id);
  return { ...server, store: server.repo, dir, call };
}

export type TestApp = Awaited<ReturnType<typeof makeTestApp>>;

/** Uploads a file through the three-step upload and returns the response of complete. */
export async function uploadFile(app: TestApp, name: string, bytes: Uint8Array, context: Record<string, unknown> = {}) {
  const created = await app.call('/projects', { json: { name, size: bytes.byteLength, context } });
  if (created.status !== 201) return created;
  const { projectId, upload } = (await created.json()) as { projectId: string; upload: { uploadId: string; partSize: number; partCount: number } };
  const parts = (await (await app.call(`/projects/${projectId}/upload/parts`, { json: { uploadId: upload.uploadId } })).json()) as {
    parts: { partNumber: number; url: string }[];
  };
  const etags = [];
  for (const part of parts.parts) {
    const chunk = bytes.subarray((part.partNumber - 1) * upload.partSize, part.partNumber * upload.partSize);
    const res = await app.app.request(part.url, { method: 'PUT', body: chunk, headers: { 'content-length': String(chunk.byteLength) } });
    if (res.status !== 200) throw new Error(`part ${part.partNumber}: ${res.status} ${await res.text()}`);
    etags.push({ partNumber: part.partNumber, etag: res.headers.get('etag')! });
  }
  return app.call(`/projects/${projectId}/upload/complete`, { json: { uploadId: upload.uploadId, parts: etags } });
}
