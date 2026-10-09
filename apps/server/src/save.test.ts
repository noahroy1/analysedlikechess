import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HistoryEntrySchema, ProjectSchema, type Project } from '@als/schema';
import { HISTORY_LIMIT } from './projects/store.ts';
import { makeTestApp } from './test-helpers.ts';

const FIXTURE = new URL('../../../fixtures/sample/project.json', import.meta.url);

const root = await mkdtemp(join(tmpdir(), 'als-save-'));
const { store, app } = await makeTestApp(root);
let project: Project;

afterAll(() => rm(root, { recursive: true, force: true }));

beforeEach(async () => {
  const fixture = ProjectSchema.parse(JSON.parse(await readFile(FIXTURE, 'utf8')));
  const id = await store.createDir('save');
  project = await store.create({ ...fixture, id, version: 1 });
});

const put = (body: unknown) =>
  app.request(`/api/projects/${project.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const edit = (version: number, label: string) => ({
  version,
  moments: project.moments.map((m, i) => (i === 0 ? { ...m, moveLabel: label } : m)),
  characters: project.context.characters,
});

describe('autosave', () => {
  it('saves edits and bumps the version', async () => {
    const res = await put(edit(1, 'Renamed'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 2 });
    const saved = await store.read(project.id);
    expect(saved.version).toBe(2);
    expect(saved.moments[0]!.moveLabel).toBe('Renamed');
  });

  it('rejects a stale version with 409 and changes nothing', async () => {
    await put(edit(1, 'First'));
    const res = await put(edit(1, 'Second'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ current: 2 });
    expect((await store.read(project.id)).moments[0]!.moveLabel).toBe('First');
  });

  it('rejects edits that break the track rules', async () => {
    const [a, b, c] = project.moments;
    const res = await put({ version: 1, moments: [a, { ...b, sourceTime: a!.sourceTime + 0.1 }, c], characters: [] });
    expect(res.status).toBe(400);
    expect((await store.read(project.id)).version).toBe(1);
  });

  it('keeps the editor away from ingest-owned fields', async () => {
    await put({ ...edit(1, 'x'), shots: [], source: { file: 'evil' } });
    const saved = await store.read(project.id);
    expect(saved.shots).toEqual(project.shots);
    expect(saved.source.file).toBe(project.source.file);
  });
});

describe('history', () => {
  it(`keeps the last ${HISTORY_LIMIT} saved versions`, async () => {
    for (let v = 1; v <= HISTORY_LIMIT + 5; v++) expect((await put(edit(v, `v${v}`))).status).toBe(200);
    const history = HistoryEntrySchema.array().parse(await (await app.request(`/api/projects/${project.id}/history`)).json());
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]!.version).toBe(HISTORY_LIMIT + 5);
    expect(history.at(-1)!.version).toBe(6);
  });

  it('restores an earlier version as a new version', async () => {
    await put(edit(1, 'Good edit'));
    await put(edit(2, 'Bad edit'));
    const res = await app.request(`/api/projects/${project.id}/history/2/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 3 }),
    });
    expect(res.status).toBe(200);
    const restored = await store.read(project.id);
    expect(restored.version).toBe(4);
    expect(restored.moments[0]!.moveLabel).toBe('Good edit');
  });

  it('404s for a version that is not kept', async () => {
    const res = await app.request(`/api/projects/${project.id}/history/99/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
