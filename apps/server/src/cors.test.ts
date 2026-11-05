import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPACITOR_ORIGINS, MediaGrantSchema, ProjectSchema, grantUrl } from '@als/schema';
import { projectKey } from './ports.ts';
import { makeTestApp, type TestApp } from './test-helpers.ts';

// Cross-origin calls (PLAN-CLOUD.md, C4 "CORS"): the deployed web app and the
// mobile app call the API from other origins; anything else gets no CORS headers.

const WEB = 'https://studio.example';
const [IOS, ANDROID] = CAPACITOR_ORIGINS;

let root: string;
let env: TestApp;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'als-cors-'));
  env = await makeTestApp(root, {}, undefined, { corsOrigins: [...CAPACITOR_ORIGINS, WEB] });
});

afterAll(() => rm(root, { recursive: true, force: true }));

const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => env.app.request(`/api/v1${path}`, init);
const allowed = (res: Response) => res.headers.get('Access-Control-Allow-Origin');

describe('CORS', () => {
  it('answers a preflight from the mobile app and the web app without sign-in', async () => {
    for (const origin of [IOS!, ANDROID!, WEB]) {
      const res = await request('/projects', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key,x-client-version' },
      });
      expect(res.status).toBe(204);
      expect(allowed(res)).toBe(origin);
      expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD,PUT,POST,DELETE');
      expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase().split(',')).toEqual(
        expect.arrayContaining(['authorization', 'content-type', 'idempotency-key', 'x-client-version', 'range']),
      );
      expect(res.headers.get('Access-Control-Max-Age')).toBe('600');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    }
  });

  it('allows the listed origins on answers and errors, and no other origin', async () => {
    const ok = await request('/health', { headers: { Origin: IOS! } });
    expect(ok.status).toBe(200);
    expect(allowed(ok)).toBe(IOS);
    expect(ok.headers.get('Vary')).toContain('Origin');
    // An error thrown by a later middleware still carries the header, so the app can read its code.
    const old = await request('/health', { headers: { Origin: WEB, 'X-Client-Version': '0.9.0' } });
    expect(old.status).toBe(426);
    expect(allowed(old)).toBe(WEB);
    expect(await old.json()).toMatchObject({ code: 'client_too_old' });
    const missing = await request('/nowhere', { headers: { Origin: ANDROID! } });
    expect(missing.status).toBe(404);
    expect(allowed(missing)).toBe(ANDROID);

    const other = await request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(allowed(other)).toBeNull();
    const otherPreflight = await request('/projects', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
    expect(allowed(otherPreflight)).toBeNull();
  });

  it('lets the Player read a ranged media answer', async () => {
    const fixture = ProjectSchema.parse(JSON.parse(await readFile(new URL('../../../fixtures/sample/project.json', import.meta.url), 'utf8')));
    const project = await env.store.create({ ...fixture, id: await env.store.newId('cors'), version: 1 });
    await env.blobs.put(projectKey(project.id, 'proxy.mp4'), new Uint8Array(1000));
    const grant = MediaGrantSchema.parse(await (await env.call(`/projects/${project.id}/media`)).json());
    const res = await env.app.request(grantUrl(grant, 'proxy.mp4'), { headers: { Origin: IOS!, Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(allowed(res)).toBe(IOS);
    expect(res.headers.get('Access-Control-Expose-Headers')?.split(',')).toEqual(expect.arrayContaining(['Content-Range', 'ETag']));
  });

  it('sends no CORS headers when no origins are configured (the Node server)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'als-cors-off-'));
    const plain = await makeTestApp(dir);
    const res = await plain.app.request('/api/v1/health', { headers: { Origin: IOS! } });
    expect(res.status).toBe(200);
    expect(allowed(res)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
