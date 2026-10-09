import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { IngestQueue } from './ingest/queue.ts';
import { ProjectStore } from './projects/store.ts';

const port = Number(process.env.PORT ?? 8787);
const projectsDir = process.env.PROJECTS_DIR ?? fileURLToPath(new URL('../../../projects', import.meta.url));

const store = new ProjectStore(projectsDir);
const queue = new IngestQueue(store);
const app = createApp({ store, queue });

// Resume ingests a restart interrupted; finished steps are cached, so this picks up where it stopped.
for (const project of await store.list()) {
  if (project.ingest.status === 'pending' || project.ingest.status === 'running') queue.enqueue(project.id);
}

// Local single-user app: listen on loopback only.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`server listening on http://127.0.0.1:${info.port} (projects in ${projectsDir})`);
});
