// Dev seeding through the API, as the dev user (`pnpm dev` must be running):
//   pnpm seed:sample                       a new project from fixtures/sample (3 moments)
//   pnpm seed:moments <projectId> <file>   replace a project's moments and characters
// It uploads like the editor (create, parts, complete), then sets the fixture's
// document through the dev seeding route before ingest ends, so analysis never
// starts on its own (it does only for a clip with no moves).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  API_PREFIX,
  CharacterSchema,
  CreateProjectResultSchema,
  IDEMPOTENCY_HEADER,
  MomentSchema,
  ProjectSchema,
  UploadPartsResultSchema,
  type Project,
} from '@als/schema';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ORIGIN = process.env.SEED_API ?? 'http://127.0.0.1:8790';

function devEnv(): Record<string, string> {
  const file = join(ROOT, 'apps/web/.env.development.local');
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => /^([A-Z_]+)=(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
}

async function signIn(): Promise<string> {
  const env = devEnv();
  const res = await fetch(`${env.VITE_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.VITE_DEV_EMAIL, password: env.VITE_DEV_PASSWORD }),
  });
  if (!res.ok) throw new Error(`dev sign-in failed (${res.status}); run \`pnpm dev\`, which creates the dev user`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const token = await signIn();

async function call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const res = await fetch(`${ORIGIN}${API_PREFIX}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { [IDEMPOTENCY_HEADER]: crypto.randomUUID() }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return schema.parse(await res.json());
}

/** Uploads a clip the way the editor does and returns the new project. */
async function upload(file: string, name: string): Promise<Project> {
  const clip = readFileSync(file);
  const { projectId, upload: info } = await call('POST', '/projects', CreateProjectResultSchema, { name, size: clip.length, context: {} });
  const { parts } = await call('POST', `/projects/${projectId}/upload/parts`, UploadPartsResultSchema, { uploadId: info.uploadId });
  const done = [];
  for (const part of parts) {
    const res = await fetch(`${ORIGIN}${part.url}`, { method: 'PUT', body: clip.subarray((part.partNumber - 1) * info.partSize, part.partNumber * info.partSize) });
    if (!res.ok) throw new Error(`part ${part.partNumber}: ${res.status} ${await res.text()}`);
    done.push({ partNumber: part.partNumber, etag: ((await res.json()) as { etag: string }).etag });
  }
  return call('POST', `/projects/${projectId}/upload/complete`, ProjectSchema, { uploadId: info.uploadId, parts: done });
}

async function seedSample() {
  const fixture = ProjectSchema.parse(JSON.parse(readFileSync(join(ROOT, 'fixtures/sample/project.json'), 'utf8')));
  const project = await upload(join(ROOT, 'fixtures/sample/source.mp4'), 'sample (fixture).mp4');
  const { context, transcript, sceneNotes, moments, themeId } = fixture;
  await call('PUT', `/dev/projects/${project.id}/seed`, ProjectSchema, { context, transcript, sceneNotes, moments, themeId });
  for (;;) {
    const current = await call('GET', `/projects/${project.id}`, ProjectSchema);
    if (current.ingest.status === 'done' || current.ingest.status === 'error') {
      console.log(`created ${project.id} (ingest ${current.ingest.status}${current.ingest.error ? `: ${current.ingest.error}` : ''})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const MomentsFileSchema = z.object({ characters: z.array(CharacterSchema), moments: z.array(MomentSchema) });

async function seedMoments(id: string, file: string) {
  const data = MomentsFileSchema.parse(JSON.parse(readFileSync(resolve(file), 'utf8')));
  const current = await call('GET', `/projects/${id}`, ProjectSchema);
  const project = await call('PUT', `/dev/projects/${id}/seed`, ProjectSchema, { context: { ...current.context, characters: data.characters }, moments: data.moments });
  console.log(`${id}: ${project.moments.length} moments, version ${project.version}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'sample') await seedSample();
else if (command === 'moments' && args.length === 2) await seedMoments(args[0]!, args[1]!);
else {
  console.error('usage: seed.ts sample | seed.ts moments <projectId> <moments.json>');
  process.exitCode = 1;
}
