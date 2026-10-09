// Dev seeding until the Analyst exists (Phase 4).
//   node apps/server/src/seed.ts sample                      new project from fixtures/sample
//   node apps/server/src/seed.ts moments <projectId> <file>  replace a project's moments and characters
import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CharacterSchema, MomentSchema, ProjectSchema } from '@als/schema';
import { pendingIngest, runIngest } from './ingest/ingest.ts';
import { ProjectStore } from './projects/store.ts';

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const store = new ProjectStore(process.env.PROJECTS_DIR ?? repo('projects'));

const MomentsFileSchema = z.object({
  characters: z.array(CharacterSchema),
  moments: z.array(MomentSchema),
});

async function seedSample() {
  const fixture = ProjectSchema.parse(JSON.parse(await readFile(repo('fixtures/sample/project.json'), 'utf8')));
  const id = await store.createDir('sample');
  await copyFile(repo('fixtures/sample/source.mp4'), store.file(id, 'source.mp4'));
  await store.create({
    ...fixture,
    id,
    version: 1,
    createdAt: new Date().toISOString(),
    source: { ...fixture.source, file: 'source.mp4', proxy: 'proxy.mp4', originalName: 'sample (fixture).mp4' },
    shots: undefined,
    ingest: pendingIngest(),
  });
  const ingest = await runIngest(store, id, () => {});
  console.log(`created ${id} (ingest ${ingest.status})`);
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
