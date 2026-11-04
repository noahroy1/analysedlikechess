import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { loadAnalysisConfig } from './analysis/config.ts';
import { createNodeServer } from './node/server.ts';

const port = Number(process.env.PORT ?? 8787);
const projectsDir = process.env.PROJECTS_DIR ?? fileURLToPath(new URL('../../../projects', import.meta.url));
// Chess sounds are local files like the demo footage, never committed.
const soundsDir = process.env.SOUNDS_DIR ?? fileURLToPath(new URL('../../../media/sounds', import.meta.url));

const server = await createNodeServer({ projectsDir, soundsDir, config: loadAnalysisConfig(), origin: `http://127.0.0.1:${port}` });
await server.recover();
const missing = server.analysis.missingKeys();
if (missing.length) console.log(`analysis needs ${missing.join(', ')} in apps/server/.env`);

// Local single-user app: listen on loopback only.
serve({ fetch: server.app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`server listening on http://127.0.0.1:${info.port} (projects in ${projectsDir})`);
  // Get the browser and the composition bundle ready so the first render starts sooner.
  server.media.warmUp();
});
