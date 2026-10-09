import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import {
  SERVABLE_FILE,
  UPLOAD_EXTENSIONS,
  shotThumbnailFile,
  type IngestEvent,
  type Project,
  type ProjectSummary,
} from '@als/schema';
import { pendingIngest } from './ingest/ingest.ts';
import type { IngestQueue } from './ingest/queue.ts';
import { NotAVideoError, probe } from './media/probe.ts';
import { ProjectNotFoundError, type ProjectStore } from './projects/store.ts';

export interface AppDeps {
  store: ProjectStore;
  queue: IngestQueue;
}

const SSE_HEARTBEAT_MS = 15_000;

export function summarize(project: Project): ProjectSummary {
  const shots = project.shots ?? [];
  const thumbsReady = project.ingest.stages.some(
    (s) => s.name === 'thumbnails' && (s.status === 'done' || s.status === 'cached'),
  );
  // A shot from early in the clip, past any cold open or black lead-in.
  const posterTime = project.source.durationSec * 0.4;
  const posterIndex = shots.findIndex((s) => s.end > posterTime);
  return {
    id: project.id,
    version: project.version,
    name: project.context.movieTitle || project.source.originalName || project.id,
    createdAt: project.createdAt,
    source: project.source,
    ingest: project.ingest,
    shotCount: shots.length,
    momentCount: project.moments.length,
    ...(thumbsReady && posterIndex >= 0 ? { poster: shotThumbnailFile(posterIndex) } : {}),
  };
}

export function createApp({ store, queue }: AppDeps) {
  const app = new Hono().basePath('/api');

  app.onError((error, c) => {
    if (error instanceof ProjectNotFoundError) return c.json({ error: 'project not found' }, 404);
    if (error instanceof ZodError) return c.json({ error: error.message }, 400);
    console.error(error);
    return c.json({ error: error.message }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/projects', async (c) => c.json((await store.list()).map(summarize)));

  /**
   * Upload: the raw file is the request body (streamed to disk, never buffered),
   * with its name and optional context in the query string.
   */
  app.post('/projects', async (c) => {
    const name = c.req.query('name') ?? '';
    const ext = extname(name).slice(1).toLowerCase();
    if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
      return c.json({ error: `upload an ${UPLOAD_EXTENSIONS.join(', ').toUpperCase()} file` }, 400);
    }
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'empty upload' }, 400);

    const id = await store.createDir(name);
    const file = `source.${ext}`;
    try {
      await pipeline(
        Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
        createWriteStream(join(store.dir(id), file)),
      );
      const probed = await probe(join(store.dir(id), file));
      const movieTitle = c.req.query('movieTitle')?.trim();
      const sceneNote = c.req.query('sceneNote')?.trim();
      const project = await store.create({
        id,
        version: 1,
        createdAt: new Date().toISOString(),
        source: { file, proxy: 'proxy.mp4', originalName: name, ...probed },
        context: {
          ...(movieTitle ? { movieTitle } : {}),
          ...(sceneNote ? { sceneNote } : {}),
          characters: [],
        },
        moments: [],
        themeId: 'default',
        ingest: pendingIngest(),
        analysis: { status: 'idle', stages: [], models: {} },
      });
      queue.enqueue(id);
      return c.json(project, 201);
    } catch (error) {
      await rm(store.dir(id), { recursive: true, force: true });
      if (error instanceof NotAVideoError) {
        return c.json({ error: `that file is not a playable video (${error.message})` }, 400);
      }
      throw error;
    }
  });

  app.get('/projects/:id', async (c) => c.json(await store.read(c.req.param('id'))));

  /** Re-run ingest. Steps whose inputs are unchanged are skipped. */
  app.post('/projects/:id/ingest', async (c) => {
    const id = c.req.param('id');
    if (queue.has(id)) return c.json({ error: 'ingest is already running' }, 409);
    await store.update(id, (p) => {
      p.ingest = pendingIngest();
    });
    queue.enqueue(id);
    return c.json({ ok: true }, 202);
  });

  app.delete('/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (queue.has(id)) return c.json({ error: 'wait for ingest to finish before deleting' }, 409);
    await store.read(id);
    await store.remove(id);
    return c.body(null, 204);
  });

  // Media files, with Range support so the browser can seek.
  app.get('/projects/:id/files/*', async (c, next) => {
    const id = c.req.param('id');
    const name = c.req.path.slice(`/api/projects/${id}/files/`.length);
    if (!SERVABLE_FILE.test(name)) return c.json({ error: 'not found' }, 404);
    return serveStatic({
      path: store.file(id, name),
      onFound: (_path, ctx) => {
        // Thumbnails change only when a re-ingest changes the shots; clients cache-bust with ?v=.
        ctx.header('Cache-Control', 'no-cache');
      },
    })(c, next);
  });

  /** Live ingest progress for every project. */
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: IngestEvent) =>
        stream.writeSSE({ event: 'ingest', data: JSON.stringify(event) }).catch(() => undefined);
      for (const event of queue.snapshot()) await send(event);
      queue.on('update', send);
      stream.onAbort(() => {
        queue.off('update', send);
      });
      while (!stream.aborted) {
        await stream.sleep(SSE_HEARTBEAT_MS);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => undefined);
      }
      queue.off('update', send);
    }),
  );

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return app;
}
