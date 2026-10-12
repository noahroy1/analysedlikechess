import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectSchema, type Project } from '@als/schema';
import { makeTestApp } from '../test-helpers.ts';
import { renderId } from './renders.ts';

// Requests the render service refuses before anything renders. The render itself is in render.test.ts.
const FIXTURE = new URL('../../../../fixtures/sample/project.json', import.meta.url);

const root = await mkdtemp(join(tmpdir(), 'als-renders-'));
const { store, app } = await makeTestApp(root);
let project: Project;

afterAll(() => rm(root, { recursive: true, force: true }));

beforeEach(async () => {
  const fixture = ProjectSchema.parse(JSON.parse(await readFile(FIXTURE, 'utf8')));
  const id = await store.createDir('renders');
  project = await store.create({ ...fixture, id, version: 3 });
});

const post = (body: unknown) =>
  app.request(`/api/projects/${project.id}/renders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('render requests', () => {
  it('lists no renders for a new project', async () => {
    const res = await app.request(`/api/projects/${project.id}/renders`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('renders only the current saved version', async () => {
    const res = await post({ version: 2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ current: 3 });
  });

  it('refuses a size the clip does not scale to evenly', async () => {
    await store.update(project.id, (p) => {
      p.source = { ...p.source, width: 1000, height: 562 };
    });
    const res = await post({ version: 4, preset: '1080p' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/1080p/) });
  });

  it('404s an unknown render or project', async () => {
    expect((await app.request(`/api/projects/${project.id}/renders/v1-20260101-000000/cancel`, { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/projects/nope/renders')).status).toBe(404);
  });
});

describe('renderId', () => {
  it('names a render by version and local time', () => {
    expect(renderId(12, new Date(2026, 9, 13, 5, 7, 9))).toBe('v12-20261013-050709');
  });
});
