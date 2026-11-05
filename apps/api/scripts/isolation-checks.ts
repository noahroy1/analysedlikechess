// C3's isolation check through the API (the RLS half is apps/api/src/db/isolation.test.ts):
// a second user sees none of the first user's projects, media URLs or jobs, and
// changes nothing of hers. Runs against `pnpm dev` with two new users.
//   node apps/api/scripts/isolation-checks.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PREFIX, ProjectSchema, type Project } from '@als/schema';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:8790';
const env = Object.fromEntries(
  readFileSync(join(ROOT, 'apps/web/.env.development.local'), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!]),
);
const secret = Object.fromEntries(
  readFileSync(join(ROOT, 'apps/api/.dev.vars'), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!]),
).SUPABASE_SECRET_KEY!;
const SUPABASE = env.VITE_SUPABASE_URL!;

let failures = 0;
const result = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE}/auth/v1${path}`, { ...init, headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });

async function user(label: string) {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = crypto.randomUUID();
  const created = (await (await admin('/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) })).json()) as { id: string };
  const session = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const { access_token: token } = (await session.json()) as { access_token: string };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${ORIGIN}${API_PREFIX}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID() }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await call(method, path, body);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  return { id: created.id, call, json, remove: () => admin(`/admin/users/${created.id}`, { method: 'DELETE' }) };
}

const alice = await user('alice');
const bob = await user('bob');
try {
  // Alice: a project (uploaded, ingested, with moves), a finished render, and an upload in progress.
  const clip = readFileSync(join(ROOT, 'fixtures/sample/source.mp4'));
  const created = await alice.json<{ projectId: string; upload: { uploadId: string; partSize: number } }>('POST', '/projects', { name: 'alice.mp4', size: clip.length, context: {} });
  const id = created.projectId;
  const { parts } = await alice.json<{ parts: { partNumber: number; url: string }[] }>('POST', `/projects/${id}/upload/parts`, { uploadId: created.upload.uploadId });
  const done = [];
  for (const part of parts) {
    const res = await fetch(`${ORIGIN}${part.url}`, { method: 'PUT', body: clip.subarray((part.partNumber - 1) * created.upload.partSize, part.partNumber * created.upload.partSize) });
    done.push({ partNumber: part.partNumber, etag: ((await res.json()) as { etag: string }).etag });
  }
  await alice.json('POST', `/projects/${id}/upload/complete`, { uploadId: created.upload.uploadId, parts: done });
  const fixture = ProjectSchema.parse(JSON.parse(readFileSync(join(ROOT, 'fixtures/sample/project.json'), 'utf8')));
  await alice.json('PUT', `/dev/projects/${id}/seed`, { context: fixture.context, moments: fixture.moments, transcript: fixture.transcript });
  let project: Project;
  for (;;) {
    project = ProjectSchema.parse(await alice.json('GET', `/projects/${id}`));
    if (project.ingest.status === 'done' || project.ingest.status === 'error') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const render = await alice.json<{ id: string }>('POST', `/projects/${id}/renders`, { version: project.version });
  for (;;) {
    const list = await alice.json<{ id: string; status: string }[]>('GET', `/projects/${id}/renders`);
    if (list.find((r) => r.id === render.id)?.status !== 'running' && list.find((r) => r.id === render.id)?.status !== 'pending') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const pending = await alice.json<{ projectId: string; upload: { uploadId: string } }>('POST', '/projects', { name: 'later.mp4', size: 100, context: {} });
  const before = ProjectSchema.parse(await alice.json('GET', `/projects/${id}`));
  const moment = before.moments[0]!;
  const edit = { version: before.version, moments: before.moments, characters: before.context.characters, themeId: before.themeId };

  // Bob, signed in, aims every route at Alice's project. Each must answer as if it didn't exist.
  const attempts: [string, string, unknown?][] = [
    ['GET', `/projects/${id}`],
    ['GET', `/projects/${id}/media`],
    ['GET', `/projects/${id}/history`],
    ['GET', `/projects/${id}/usage`],
    ['GET', `/projects/${id}/renders`],
    ['GET', `/projects/${id}/renders/${render.id}/download`],
    ['PUT', `/projects/${id}`, { ...edit, moments: [] }],
    ['POST', `/projects/${id}/history/1/restore`, { version: before.version }],
    ['POST', `/projects/${id}/ingest`],
    ['POST', `/projects/${id}/analyze`, {}],
    ['POST', `/projects/${id}/regenerate`, { moment }],
    ['POST', `/projects/${id}/regions`, { moment }],
    ['POST', `/projects/${id}/evaluate`, { moments: before.moments, characters: before.context.characters }],
    ['POST', `/projects/${id}/portraits`, { characterId: before.context.characters[0]?.id ?? 'c-1', sourceTime: 1, x: 0.4, y: 0.4, size: 0.2 }],
    ['POST', `/projects/${id}/renders`, { version: before.version }],
    ['POST', `/projects/${id}/renders/${render.id}/cancel`],
    ['DELETE', `/projects/${id}/renders/${render.id}`],
    ['POST', `/projects/${pending.projectId}/upload/parts`, { uploadId: pending.upload.uploadId }],
    ['POST', `/projects/${pending.projectId}/upload/complete`, { uploadId: pending.upload.uploadId, parts: [{ partNumber: 1, etag: 'x' }] }],
    ['DELETE', `/projects/${id}`],
  ];
  const leaks: string[] = [];
  for (const [method, path, body] of attempts) {
    const res = await bob.call(method, path, body);
    if (res.status !== 404) leaks.push(`${method} ${path} → ${res.status}`);
  }
  result(`Bob gets 404 from all ${attempts.length} routes aimed at Alice's project`, leaks.length === 0, leaks.join('; '));

  const bobsList = await bob.json<{ id: string }[]>('GET', '/projects');
  result("Alice's project is not in Bob's list", !bobsList.some((p) => p.id === id), `${bobsList.length} projects`);
  await alice.json('POST', `/projects/${id}/ingest`);
  const bobsJobs = await bob.json<{ projectId: string }[]>('GET', '/jobs');
  const alicesJobs = await alice.json<{ projectId: string }[]>('GET', '/jobs');
  result("Bob's jobs leave out Alice's running ingest", alicesJobs.some((j) => j.projectId === id) && !bobsJobs.some((j) => j.projectId === id), `Alice ${alicesJobs.length}, Bob ${bobsJobs.length}`);

  // Media URLs: a grant signs one project's files; Bob's own grant can't be pointed at Alice's.
  const bobProject = await bob.json<{ projectId: string }>('POST', '/projects', { name: 'bob.mp4', size: 100, context: {} });
  const aliceGrant = await alice.json<{ base: string; query: string }>('GET', `/projects/${id}/media`);
  const own = await fetch(`${ORIGIN}${aliceGrant.base}proxy.mp4?${aliceGrant.query}`, { headers: { Range: 'bytes=0-9' } });
  const swapped = await fetch(`${ORIGIN}${aliceGrant.base.replace(id, bobProject.projectId)}proxy.mp4?${aliceGrant.query}`);
  const forged = await fetch(`${ORIGIN}${aliceGrant.base}proxy.mp4?${aliceGrant.query.replace(/sig=[^&]+/, 'sig=AAAA')}`);
  result("a media grant opens only its own project's files", own.status === 206 && swapped.status === 403 && forged.status === 403, `own ${own.status}, other project ${swapped.status}, forged ${forged.status}`);

  // Nothing of Alice's changed.
  await new Promise((r) => setTimeout(r, 1000));
  const after = ProjectSchema.parse(await alice.json('GET', `/projects/${id}`));
  const renders = await alice.json<{ id: string; status: string }[]>('GET', `/projects/${id}/renders`);
  result(
    "Alice's project, moves and render are untouched",
    after.moments.length === before.moments.length && renders.some((r) => r.id === render.id && r.status === 'done'),
    `${after.moments.length} moves, render ${renders.find((r) => r.id === render.id)?.status}`,
  );
} finally {
  await alice.remove();
  await bob.remove();
}
process.exitCode = failures ? 1 : 0;
