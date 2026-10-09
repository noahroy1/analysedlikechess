import { serve } from '@hono/node-server';
import { app } from './app.ts';

const port = Number(process.env.PORT ?? 8787);

// Local single-user app: listen on loopback only.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`server listening on http://127.0.0.1:${info.port}`);
});
