// Dev seeding until the Analyst exists (Phase 4).
//   node apps/server/src/seed.ts sample                      new project from fixtures/sample
//   node apps/server/src/seed.ts moments <projectId> <file>  replace a project's moments and characters
// `sample` asks the running server (`pnpm dev`, same PROJECTS_DIR; SEED_API overrides its origin) to
// ingest the project, since ingest runs in the media service, which reads and writes through the API.
import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { API_PREFIX, CharacterSchema, IDEMPOTENCY_HEADER, MomentSchema, ProjectSchema } from '@als/schema';
import { pendingIngest } from './ingest/ingest.ts';
import { projectKey } from './ports.ts';
import { FsBlobStore } from './node/fs-blobs.ts';
import { FsProjectRepo } from './node/fs-repo.ts';

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const projectsDir = process.env.PROJECTS_DIR ?? repo('projects');
const store = new FsProjectRepo(projectsDir);
const blobs = new FsBlobStore({ projectsDir, soundsDir: repo('media/sounds') });
const api = `${process.env.SEED_API ?? 'http://127.0.0.1:8787'}${API_PREFIX}`;

const MomentsFileSchema = z.object({
  characters: z.array(CharacterSchema),
  moments: z.array(MomentSchema),
});

async function seedSample() {
  const fixture = ProjectSchema.parse(JSON.parse(await readFile(repo('fixtures/sample/project.json'), 'utf8')));
  const id = await store.newId('sample');
  await copyFile(repo('fixtures/sample/source.mp4'), blobs.path(projectKey(id, 'source.mp4')));
  await store.create({
    ...fixture,
    id,
    version: 1,
    createdAt: new Date().toISOString(),
    source: { ...fixture.source, file: 'source.mp4', proxy: 'proxy.mp4', originalName: 'sample (fixture).mp4' },
    shots: undefined,
    ingest: pendingIngest(),
  });
  const started = await fetch(`${api}/projects/${id}/ingest`, { method: 'POST', headers: { [IDEMPOTENCY_HEADER]: `seed-${id}` } }).catch(() => undefined);
  if (!started?.ok) throw new Error(`created ${id}, but the server at ${api} did not start its ingest (${started?.status ?? 'not running'}); start \`pnpm dev\` with the same PROJECTS_DIR`);
  for (;;) {
    const project = await store.read(id);
    if (project.ingest.status === 'done' || project.ingest.status === 'error') {
      console.log(`created ${id} (ingest ${project.ingest.status}${project.ingest.error ? `: ${project.ingest.error}` : ''})`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function seedMoments(id: string, file: string) {
  const data = MomentsFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const project = await store.update(id, (p) => {
    p.context.characters = data.characters;
    p.moments = data.moments;
  });
  console.log(`${id}: ${project.moments.length} moments, version ${project.version}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'sample') await seedSample();
else if (command === 'moments' && args.length === 2) await seedMoments(args[0]!, args[1]!);
else {
  console.error('usage: seed.ts sample | seed.ts moments <projectId> <moments.json>');
  process.exitCode = 1;
}
