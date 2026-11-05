import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { loadAnalysisConfig } from './analysis/config.ts';
import { createNodeServer } from './node/server.ts';
import { DEFAULT_RENDER_SPLIT } from './render/renders.ts';

const port = Number(process.env.PORT ?? 8787);
const projectsDir = process.env.PROJECTS_DIR ?? fileURLToPath(new URL('../../../projects', import.meta.url));
// Chess sounds are local files like the demo footage, never committed.
const soundsDir = process.env.SOUNDS_DIR ?? fileURLToPath(new URL('../../../media/sounds', import.meta.url));

// The media service (apps/media, started by `pnpm dev`); a comma-separated list spreads render chunks over several.
const mediaUrls = (process.env.MEDIA_URL ?? 'http://127.0.0.1:8788').split(',').map((u) => u.trim()).filter(Boolean);
// How the media service reaches this server (a container uses http://host.docker.internal:8787).
const origin = process.env.MEDIA_API_ORIGIN ?? `http://127.0.0.1:${port}`;
const renderSplit = {
  ...DEFAULT_RENDER_SPLIT,
  ...(process.env.RENDER_CHUNKS ? { maxChunks: Number(process.env.RENDER_CHUNKS) } : {}),
  ...(process.env.RENDER_CHUNK_MIN_FRAMES ? { minChunkFrames: Number(process.env.RENDER_CHUNK_MIN_FRAMES) } : {}),
};

const server = await createNodeServer({ projectsDir, soundsDir, config: loadAnalysisConfig(), origin, mediaUrls, renderSplit });
await server.recover();
const missing = server.analysis.missingKeys();
if (missing.length) console.log(`analysis needs ${missing.join(', ')} in apps/server/.env`);

// Local single-user app: listen on loopback only.
serve({ fetch: server.app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`server listening on http://127.0.0.1:${info.port} (projects in ${projectsDir}, media service at ${mediaUrls.join(', ')})`);
  // Get the media service's browser and composition bundle ready so the first render starts sooner.
  server.media.warmUp();
});
