import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createMediaServer } from '@als/media/server';
import { API_PREFIX, IDEMPOTENCY_HEADER } from '@als/schema';
import { loadAnalysisConfig, type AnalysisConfig } from './analysis/config.ts';
import { createNodeServer, type NodeServerOptions } from './node/server.ts';

/** Recorded provider responses for the dialogue fixture; tests never call cloud APIs. */
export const DIALOGUE_RECORDING = fileURLToPath(new URL('../../../fixtures/dialogue/recorded', import.meta.url));

export const TEST_MEDIA_SECRET = 'test-media-url-secret-0123456789abcdef';

/** Serves a fetch handler on a free loopback port; the servers never keep a test process alive. */
async function listen(fetch: (request: Request) => Response | Promise<Response>): Promise<string> {
  const server = serve({ fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * The whole server against a scratch projects folder, with replayed providers.
 * It listens on loopback beside its own media service (as `pnpm dev` runs
 * them), since the service reads and writes through the API; tests still call
 * the app directly with `call`.
 */
export async function makeTestApp(
  root: string,
  overrides: Partial<AnalysisConfig> = {},
  soundsDir = join(root, 'sounds'),
  options: Pick<NodeServerOptions, 'capUsd' | 'providers' | 'wrapMedia' | 'renderSplit'> = {},
) {
  const config: AnalysisConfig = { ...loadAnalysisConfig({}), autoAnalyze: false, replayDir: DIALOGUE_RECORDING, ...overrides };
  const media = createMediaServer({ workRoot: join(root, '.media-work') });
  const mediaUrl = await listen(media.app.fetch);
  // The API's port comes first: the server needs its own origin to sign the media service's URLs.
  const api: { fetch?: (request: Request) => Response | Promise<Response> } = {};
  const origin = await listen((request) => api.fetch!(request));
  const server = await createNodeServer({ projectsDir: root, soundsDir, config, origin, mediaUrls: [mediaUrl], mediaSecret: TEST_MEDIA_SECRET, ...options });
  api.fetch = server.app.fetch;
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
