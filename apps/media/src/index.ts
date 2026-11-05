import { serve } from '@hono/node-server';
import { createMediaServer } from './server.ts';

// The media service as its own process: `pnpm dev` starts it on loopback for the
// Node API (MEDIA_URL there); the container image listens on every interface.
const port = Number(process.env.PORT ?? 8788);
const hostname = process.env.HOST ?? '127.0.0.1';
const media = createMediaServer({
  ...(process.env.MEDIA_WORK_DIR ? { workRoot: process.env.MEDIA_WORK_DIR } : {}),
  ...(process.env.MEDIA_BUNDLE_DIR ? { bundleDir: process.env.MEDIA_BUNDLE_DIR } : {}),
});

serve({ fetch: media.app.fetch, port, hostname }, (info) => {
  console.log(`media service listening on http://${hostname}:${info.port}`);
  // Get the browser and the composition bundle ready so the first render starts sooner.
  media.warmUp();
});
