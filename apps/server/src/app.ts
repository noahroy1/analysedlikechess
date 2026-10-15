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
  AnalyzeRequestSchema,
  ProjectEditSchema,
  EvaluateRequestSchema,
  PortraitRequestSchema,
  RegenerateRequestSchema,
  RegionsRequestSchema,
  RenderRequestSchema,
  SERVABLE_FILE,
  UPLOAD_EXTENSIONS,
  shotThumbnailFile,
  projectName,
  type Project,
  type ProjectSummary,
  type RenderJob,
} from '@als/schema';
import { ProviderError } from './analysis/providers/index.ts';
import { AnalysisBusyError, type AnalysisService } from './analysis/service.ts';
import { pendingIngest } from './ingest/ingest.ts';
import type { IngestQueue } from './ingest/queue.ts';
import { NotAVideoError, probe } from './media/probe.ts';
import { extractPortrait, portraitFile } from './media/portrait.ts';
import type { SoundLibrary } from './media/sounds.ts';
import { ProjectNotFoundError, VersionConflictError, type ProjectStore } from './projects/store.ts';
import { RenderBusyError, RenderNotFoundError, RenderPresetError, type RenderService } from './render/renders.ts';

export interface AppDeps {
  store: ProjectStore;
  queue: IngestQueue;
  analysis: AnalysisService;
  sounds: SoundLibrary;
  renders: RenderService;
}

/** Keep in step with EVENTS_STALE_MS in apps/web/src/lib/api.ts, which reopens a stream that misses two. */
const SSE_HEARTBEAT_MS = 5_000;

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
    name: projectName(project),
    createdAt: project.createdAt,
    source: project.source,
    ingest: project.ingest,
    analysis: project.analysis,
    shotCount: shots.length,
    momentCount: project.moments.length,
    ...(thumbsReady && posterIndex >= 0 ? { poster: shotThumbnailFile(posterIndex) } : {}),
  };
}

export function createApp({ store, queue, analysis, sounds, renders }: AppDeps) {
  const app = new Hono().basePath('/api');

  // A clip that finishes ingest goes straight on to analysis (when keys are set).
  queue.on('update', ({ projectId, state }) => {
    if (state.status === 'done') void analysis.autoStart(projectId);
  });

  app.onError((error, c) => {
    if (error instanceof ProjectNotFoundError) return c.json({ error: 'project not found' }, 404);
    if (error instanceof VersionConflictError) {
      return c.json({ error: 'the project changed since it was loaded', current: error.current }, 409);
    }
    if (error instanceof ZodError) return c.json({ error: error.message }, 400);
    if (error instanceof AnalysisBusyError) return c.json({ error: error.message }, 409);
    if (error instanceof ProviderError) return c.json({ error: error.message }, 502);
    if (error instanceof RenderBusyError) return c.json({ error: error.message }, 409);
    if (error instanceof RenderNotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof RenderPresetError) return c.json({ error: error.message }, 400);
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
      // Characters typed at upload: they guide speaker naming and transcription spelling.
      const names = [...new Set((c.req.query('characters') ?? '').split(',').map((n) => n.trim()).filter(Boolean))];
      const project = await store.create({
        id,
        version: 1,
        createdAt: new Date().toISOString(),
        source: { file, proxy: 'proxy.mp4', originalName: name, ...probed },
        context: {
          ...(movieTitle ? { movieTitle } : {}),
          ...(sceneNote ? { sceneNote } : {}),
          characters: names.map((name, i) => ({ id: `c-${i + 1}`, name, speakerLabels: [] })),
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

  /** Editor autosave. Rejected with 409 unless based on the current version. */
  app.put('/projects/:id', async (c) => {
    const edit = ProjectEditSchema.parse(await c.req.json());
    const saved = await store.save(c.req.param('id'), edit.version, (p) => {
      p.moments = edit.moments;
      p.context.characters = edit.characters;
      p.themeId = edit.themeId;
      if (edit.format) p.format = edit.format;
      if (edit.evalBar) p.evalBar = edit.evalBar;
      else delete p.evalBar;
      if (edit.subtitles) p.subtitles = edit.subtitles;
      else delete p.subtitles;
      if (edit.title) p.title = edit.title;
      else delete p.title;
      if (edit.evalBarScale) p.evalBarScale = edit.evalBarScale;
      else delete p.evalBarScale;
      if (edit.gameReview) p.gameReview = edit.gameReview;
      else delete p.gameReview;
    });
    return c.json({ version: saved.version });
  });

  /** The last saved versions, newest first. */
  app.get('/projects/:id/history', async (c) => c.json(await store.history(c.req.param('id'))));

  /** Bring back an earlier version's moments, characters, theme, format, bar, subtitles and game review as a new version (the name stays). */
  app.post('/projects/:id/history/:version/restore', async (c) => {
    const id = c.req.param('id');
    const { version } = ProjectEditSchema.pick({ version: true }).parse(await c.req.json());
    const old = await store.readVersion(id, Number(c.req.param('version')));
    const saved = await store.save(id, version, (p) => {
      p.moments = old.moments;
      p.context.characters = old.context.characters;
      p.themeId = old.themeId;
      if (old.format) p.format = old.format;
      else delete p.format;
      if (old.evalBar) p.evalBar = old.evalBar;
      else delete p.evalBar;
      if (old.subtitles) p.subtitles = old.subtitles;
      else delete p.subtitles;
      if (old.evalBarScale) p.evalBarScale = old.evalBarScale;
      else delete p.evalBarScale;
      if (old.gameReview) p.gameReview = old.gameReview;
      else delete p.gameReview;
    });
    return c.json(saved);
  });

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

  /** What analysis can do here: which keys are missing and which models run. */
  app.get('/analysis/config', (c) =>
    c.json({
      missingKeys: analysis.missingKeys(),
      models: analysis.config.models,
      autoAnalyze: analysis.config.autoAnalyze,
      replay: Boolean(analysis.config.replayDir),
    }),
  );

  /** Start analysis, or re-run it (`rerun: 'analyst'` keeps the transcript and scene notes). */
  app.post('/projects/:id/analyze', async (c) => {
    const missing = analysis.missingKeys();
    if (missing.length) return c.json({ error: `Add ${missing.join(', ')} to apps/server/.env` }, 400);
    const request = AnalyzeRequestSchema.parse(await c.req.json().catch(() => ({})));
    await analysis.start(c.req.param('id'), request);
    return c.json({ ok: true }, 202);
  });

  /** Pass B for one moment. Returns a proposal; the editor decides whether to keep it. */
  app.post('/projects/:id/regenerate', async (c) => {
    const { moment, instruction, format } = RegenerateRequestSchema.parse(await c.req.json());
    return c.json(await analysis.regenerate(c.req.param('id'), moment, instruction, format));
  });

  /** Faces and subject on a move's frozen frame (cached per frame). A proposal: the editor places the card. */
  app.post('/projects/:id/regions', async (c) => {
    const { moment } = RegionsRequestSchema.parse(await c.req.json());
    return c.json(await analysis.regions(c.req.param('id'), moment));
  });

  /** Re-evaluate the bar for the editor's track (Pass C alone). A proposal: the project is not saved. */
  app.post('/projects/:id/evaluate', async (c) => {
    const request = EvaluateRequestSchema.parse(await c.req.json());
    return c.json(await analysis.evaluate(c.req.param('id'), request));
  });

  /** Spend on Regenerate and Re-evaluate, logged beside the project so it never forces an editor reload. */
  app.get('/projects/:id/usage', async (c) => c.json(await analysis.usage(c.req.param('id'))));

  app.delete('/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (queue.has(id)) return c.json({ error: 'wait for ingest to finish before deleting' }, 409);
    if (analysis.queue.has(id)) return c.json({ error: 'wait for analysis to finish before deleting' }, 409);
    if (renders.queue.has(id)) return c.json({ error: 'wait for the render to finish before deleting' }, 409);
    await store.read(id);
    await store.remove(id);
    return c.body(null, 204);
  });

  /** Crops a portrait from one frame. Saves only the image; the editor puts it on the character. */
  app.post('/projects/:id/portraits', async (c) => {
    const id = c.req.param('id');
    const request = PortraitRequestSchema.parse(await c.req.json());
    const project = await store.read(id);
    const file = portraitFile(request);
    await extractPortrait(store.file(id, project.source.file), store.file(id, file), request, project.source);
    return c.json({ file });
  });

  /** Renders of the project, newest first. */
  app.get('/projects/:id/renders', async (c) => c.json(await renders.list(c.req.param('id'))));

  /** Render the project as saved at `version` (409 if it has moved on, so the editor saves first). */
  app.post('/projects/:id/renders', async (c) => {
    const request = RenderRequestSchema.parse(await c.req.json());
    return c.json(await renders.start(c.req.param('id'), request), 202);
  });

  app.post('/projects/:id/renders/:render/cancel', async (c) => {
    await renders.cancel(c.req.param('id'), c.req.param('render'));
    return c.json({ ok: true });
  });

  /** Shows the finished MP4 in Finder. */
  app.post('/projects/:id/renders/:render/reveal', async (c) => {
    await renders.reveal(c.req.param('id'), c.req.param('render'));
    return c.json({ ok: true });
  });

  app.delete('/projects/:id/renders/:render', async (c) => {
    await renders.remove(c.req.param('id'), c.req.param('render'));
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

  /** The chess sounds that exist, with their lengths, for the Player and the renderer. */
  app.get('/sounds', async (c) => c.json(await sounds.bank()));

  app.get('/sounds/:file', async (c, next) => {
    const path = sounds.path(c.req.param('file'));
    if (!path) return c.json({ error: 'not found' }, 404);
    return serveStatic({ path })(c, next);
  });

  /** Live ingest, analysis and render progress for every project. */
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const write = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined);
      const sendIngest = ({ projectId, state }: { projectId: string; state: Project['ingest'] }) =>
        write('ingest', { projectId, ingest: state });
      const sendAnalysis = ({ projectId, state }: { projectId: string; state: Project['analysis'] }) =>
        write('analysis', { projectId, analysis: state });
      const sendRender = ({ projectId, state }: { projectId: string; state: RenderJob }) => write('render', { projectId, render: state });
      // Send something at once so the stream opens now: until the first write nothing reaches the browser,
      // and a restart before then leaves it waiting forever behind the dev proxy. EventSource drops empty data.
      const ping = () => stream.writeSSE({ event: 'ping', data: 'ok' }).catch(() => undefined);
      await ping();
      for (const update of queue.snapshot()) await sendIngest(update);
      for (const update of analysis.queue.snapshot()) await sendAnalysis(update);
      for (const update of renders.queue.snapshot()) await sendRender(update);
      queue.on('update', sendIngest);
      analysis.queue.on('update', sendAnalysis);
      renders.queue.on('update', sendRender);
      const detach = () => {
        queue.off('update', sendIngest);
        analysis.queue.off('update', sendAnalysis);
        renders.queue.off('update', sendRender);
      };
      stream.onAbort(detach);
      while (!stream.aborted) {
        await stream.sleep(SSE_HEARTBEAT_MS);
        if (!stream.aborted) await ping();
      }
      detach();
    }),
  );

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return app;
}
