import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadAnalysisConfig } from './analysis/config.ts';
import { makeProviders } from './analysis/providers/index.ts';
import { AnalysisService } from './analysis/service.ts';
import { createIngestQueue } from './ingest/queue.ts';
import { SoundLibrary } from './media/sounds.ts';
import { ProjectStore } from './projects/store.ts';

const port = Number(process.env.PORT ?? 8787);
const projectsDir = process.env.PROJECTS_DIR ?? fileURLToPath(new URL('../../../projects', import.meta.url));
// Chess sounds are local files like the demo footage, never committed.
const soundsDir = process.env.SOUNDS_DIR ?? fileURLToPath(new URL('../../../media/sounds', import.meta.url));

const store = new ProjectStore(projectsDir);
const queue = createIngestQueue(store);
const config = loadAnalysisConfig();
const analysis = await AnalysisService.load(store, makeProviders(config), config);
const app = createApp({ store, queue, analysis, sounds: new SoundLibrary(soundsDir) });

// Resume ingests a restart interrupted; finished steps are cached, so this picks up where it stopped.
for (const project of await store.list()) {
  if (project.ingest.status === 'pending' || project.ingest.status === 'running') queue.enqueue(project.id);
  else if (project.analysis.status === 'pending' || project.analysis.status === 'running') void analysis.start(project.id);
}
const missing = analysis.missingKeys();
if (missing.length) console.log(`analysis needs ${missing.join(', ')} in apps/server/.env`);

// Local single-user app: listen on loopback only.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`server listening on http://127.0.0.1:${info.port} (projects in ${projectsDir})`);
});
