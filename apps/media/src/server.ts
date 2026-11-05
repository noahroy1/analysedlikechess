import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { FrameTaskSchema, PortraitTaskSchema, ProbeTaskSchema, StartMediaTaskSchema, type StartMediaTask } from '@als/schema';
import { EpisodeBundle } from './bundle.ts';
import { hashUrl } from './io.ts';
import { audio, frame, portrait, proxy, shots, thumbnails, type StepContext } from './ingest.ts';
import { NotAVideoError, probe } from './probe.ts';
import { combine, ensureBrowser, renderChunk } from './render.ts';
import { TaskRegistry } from './tasks.ts';

export interface MediaServerOptions {
  /** Scratch space; each process works in its own folder under it. */
  workRoot?: string;
  /** A bundle built into the image (`build-bundle.ts`). Absent: bundled on first use and rebuilt when the sources change. */
  bundleDir?: string;
}

/**
 * The media service: ffmpeg and Remotion behind HTTP (contract in
 * packages/schema/src/media.ts). Probe, frame and portrait answer at once;
 * everything else is a task that reports to its callback.
 */
export function createMediaServer(options: MediaServerOptions = {}) {
  const bundle = new EpisodeBundle(options.bundleDir);

  const handle = async (task: StartMediaTask, context: StepContext) => {
    switch (task.op) {
      case 'hash':
        return { sha256: await hashUrl(task.input, context.progress, context.signal) };
      case 'shots':
        return { shots: await shots(task, context) };
      case 'combine':
        return { sizeBytes: await combine(task, context) };
      case 'proxy':
        await proxy(task, context);
        break;
      case 'audio':
        await audio(task, context);
        break;
      case 'thumbnails':
        await thumbnails(task, context);
        break;
      case 'render-chunk':
        await renderChunk(task, bundle, context);
        break;
    }
    return {};
  };
  const workRoot = options.workRoot ?? join(tmpdir(), 'als-media');
  const tasks = new TaskRegistry(handle, workRoot);

  const warmUp = () => {
    void ensureBrowser().catch((error: unknown) => console.warn('render browser not ready:', error));
    void bundle.serveUrl().catch((error: unknown) => console.warn('render bundle failed:', error));
  };

  const app = new Hono().basePath('/v1');
  app.onError((error, c) => {
    if (error instanceof ZodError) return c.json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'invalid_request' }, 400);
    if (error instanceof NotAVideoError) return c.json({ error: error.message, code: 'not_a_video' }, 422);
    console.warn('media request failed:', error);
    return c.json({ error: error instanceof Error ? error.message : String(error), code: 'failed' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found', code: 'not_found' }, 404));

  app.get('/health', (c) => c.json({ ok: true, running: tasks.running }));

  /** Gets the browser and bundle ready ahead of the first render. */
  app.post('/warm', (c) => {
    warmUp();
    return c.json({ ok: true }, 202);
  });

  app.post('/probe', async (c) => c.json(await probe(ProbeTaskSchema.parse(await c.req.json()).input)));

  app.post('/frame', async (c) => {
    const task = FrameTaskSchema.parse(await c.req.json());
    return c.body(new Uint8Array(await frame(task.input, task.frame, task.fps)), 200, { 'content-type': 'image/jpeg' });
  });

  app.post('/portrait', async (c) => {
    const work = join(workRoot, 'quick', `portrait-${randomUUID()}`);
    try {
      await portrait(PortraitTaskSchema.parse(await c.req.json()), work);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return c.json({ ok: true });
  });

  app.post('/tasks', async (c) => c.json(tasks.start(StartMediaTaskSchema.parse(await c.req.json())), 202));

  app.get('/tasks/:id', (c) => {
    const status = tasks.get(c.req.param('id'));
    return status ? c.json(status) : c.json({ error: 'no such task', code: 'not_found' }, 404);
  });

  app.post('/tasks/:id/cancel', (c) => {
    const status = tasks.cancel(c.req.param('id'));
    return status ? c.json(status) : c.json({ error: 'no such task', code: 'not_found' }, 404);
  });

  return { app, tasks, warmUp };
}

export type MediaServer = ReturnType<typeof createMediaServer>;
