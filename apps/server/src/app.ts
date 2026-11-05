import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  API_PREFIX,
  AnalyzeRequestSchema,
  CLIENT_VERSION_HEADER,
  CompleteUploadRequestSchema,
  CreateProjectRequestSchema,
  MediaTaskEventSchema,
  EvaluateRequestSchema,
  MIN_CLIENT_VERSION,
  MEDIA_URL_TTL_SEC,
  PortraitRequestSchema,
  ProjectEditSchema,
  RegenerateRequestSchema,
  RegionsRequestSchema,
  RenderRequestSchema,
  SERVABLE_FILE,
  UPLOAD_PART_BYTES,
  UploadPartsRequestSchema,
  clientVersionOk,
  grantUrl,
  projectName,
  shotThumbnailFile,
  type AnalysisConfigInfo,
  type CreateProjectResult,
  type Job,
  type MediaGrant,
  type MediaTaskEvent,
  type Me,
  type Project,
  type ProjectSummary,
  type UploadPartsResult,
  type UploadRecord,
} from '@als/schema';
import { PROJECT_THEME_ID } from '@als/theme/themes';
import type { AnalysisService } from './analysis/service.ts';
import { ApiError, errorResponse } from './api/errors.ts';
import { idempotency, type IdempotencyStore } from './api/idempotency.ts';
import { SOUNDS_SCOPE, mediaInScope, mediaOutScope, mediaTaskScope, projectScope, uploadPartScope, type MediaSigner } from './api/media-urls.ts';
import { contentType, parseRange } from './api/range.ts';
import { pendingIngest } from './ingest/ingest.ts';
import type { IngestService } from './ingest/service.ts';
import { SoundLibrary } from './node/sounds.ts';
import { portraitFile } from './portraits.ts';
import { JobRunningError, NotFoundError, projectKey, soundKey, type BlobStore, type JobRunner, type MediaRunner, type ProjectRepo } from './ports.ts';
import type { RenderService } from './render/renders.ts';
import type { Spend } from './spend.ts';

export interface AppDeps {
  repo: ProjectRepo;
  blobs: BlobStore;
  media: MediaRunner;
  jobs: JobRunner;
  ingest: IngestService;
  analysis: AnalysisService;
  renders: RenderService;
  sounds: SoundLibrary;
  signer: MediaSigner;
  idempotency: IdempotencyStore;
  spend: Spend;
  /** The dev transport for live job updates (C3: Realtime Broadcast, so no route). */
  events?: { subscribe(userId: string, listener: (job: Job) => void): () => void };
  /** Who every request is from until sign-in exists (C3: the JWT's subject). */
  userId: string;
  /** Hands a media task's callback to the call waiting for it (the HTTP media runner). */
  mediaTasks?: { deliver(taskId: string, event: MediaTaskEvent): boolean };
}

/** Heartbeat of the dev event stream; clients reopen a stream that misses two. */
const SSE_HEARTBEAT_MS = 5_000;

export function summarize(project: Project, media?: MediaGrant): ProjectSummary {
  const shots = project.shots ?? [];
  const thumbsReady = project.ingest.stages.some((s) => s.name === 'thumbnails' && (s.status === 'done' || s.status === 'cached'));
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
    ...(media ? { media } : {}),
  };
}

/** Signed URLs that carry raw bytes or a service's callback, not a client's intent: no idempotency key. */
const UNKEYED_PATH = new RegExp(`^${API_PREFIX}/(?:uploads|media)/`);

/** The v1 API (PLAN-CLOUD.md, "API contract"), on whatever the deps are backed by. */
export function createApp(deps: AppDeps) {
  const { repo, blobs, media, jobs, ingest, analysis, renders, sounds, signer, spend } = deps;
  const app = new Hono<{ Variables: { userId: string } }>().basePath(API_PREFIX);

  app.onError((error, c) => errorResponse(c, error));
  app.notFound((c) => errorResponse(c, new ApiError(404, 'not_found', 'not found')));

  app.use('*', async (c, next) => {
    const version = c.req.header(CLIENT_VERSION_HEADER);
    if (version !== undefined && !clientVersionOk(version)) {
      throw new ApiError(426, 'client_too_old', `This app is too old for the server (needs ${MIN_CLIENT_VERSION} or later). Update it to carry on.`);
    }
    c.set('userId', deps.userId);
    await next();
  });
  // Upload parts and the media service's files are signed URLs carrying raw bytes (a repeated PUT replaces
  // the file), and its callbacks report a task's state: none of them needs a key.
  app.use('*', idempotency(deps.idempotency, { skip: (path) => UNKEYED_PATH.test(path) }));

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/me', async (c) => {
    const userId = c.get('userId');
    const me: Me = { user: { id: userId }, role: 'admin', ...(await spend.status(userId)) };
    return c.json(me);
  });

  /** The user's pending and running jobs: clients read this on connect and after every reconnect or resume. */
  app.get('/jobs', (c) => c.json(jobs.list(c.get('userId'))));

  app.get('/projects', async (c) => {
    const userId = c.get('userId');
    const projects = await repo.list();
    return c.json(await Promise.all(projects.map(async (p) => summarize(p, await signer.grant(userId, p.id)))));
  });

  /** Step 1 of an upload: reserve the project and start a multipart upload. Nothing is listed until it completes. */
  app.post('/projects', async (c) => {
    const request = CreateProjectRequestSchema.parse(await c.req.json());
    const ext = request.name.split('.').pop()!.toLowerCase();
    const projectId = await repo.newId(request.name);
    const file = `source.${ext}`;
    const upload: UploadRecord = {
      projectId,
      uploadId: await blobs.createMultipart(projectKey(projectId, file)),
      file,
      originalName: request.name,
      size: request.size,
      partSize: UPLOAD_PART_BYTES,
      partCount: Math.max(1, Math.ceil(request.size / UPLOAD_PART_BYTES)),
      context: request.context,
      createdAt: new Date().toISOString(),
    };
    await repo.putUpload(upload);
    const result: CreateProjectResult = { projectId, upload: { uploadId: upload.uploadId, partSize: upload.partSize, partCount: upload.partCount } };
    return c.json(result, 201);
  });

  const openUpload = async (projectId: string, uploadId: string) => {
    const upload = await repo.getUpload(projectId);
    if (!upload || upload.uploadId !== uploadId) throw new NotFoundError('upload not found');
    return upload;
  };

  /** Step 2: signed URLs for the parts (all of them by default), and the parts already stored. Safe to ask again to resume. */
  app.post('/projects/:id/upload/parts', async (c) => {
    const projectId = c.req.param('id');
    const request = UploadPartsRequestSchema.parse(await c.req.json());
    const upload = await openUpload(projectId, request.uploadId);
    const numbers = request.partNumbers ?? Array.from({ length: upload.partCount }, (_, i) => i + 1);
    if (numbers.some((n) => n > upload.partCount)) throw new ApiError(400, 'invalid_request', `this upload has ${upload.partCount} parts`);
    let expiresAt = '';
    const parts = await Promise.all(
      numbers.map(async (partNumber) => {
        const signed = await signer.sign(uploadPartScope(projectId, upload.uploadId, partNumber), c.get('userId'));
        expiresAt = signed.expiresAt;
        return { partNumber, url: `${API_PREFIX}/uploads/${projectId}/${upload.uploadId}/${partNumber}?${signed.query}` };
      }),
    );
    const uploaded = await blobs.listParts(projectKey(projectId, upload.file), upload.uploadId);
    const result: UploadPartsResult = { parts, uploaded, expiresAt: expiresAt || new Date(Date.now() + MEDIA_URL_TTL_SEC * 1000).toISOString() };
    return c.json(result);
  });

  /** A part's bytes, at its signed URL. Every part but the last is exactly `partSize`. */
  app.put('/uploads/:id/:upload/:part', async (c) => {
    const projectId = c.req.param('id');
    const partNumber = Number(c.req.param('part'));
    const userId = await signer.verify(uploadPartScope(projectId, c.req.param('upload'), partNumber), new URL(c.req.url).searchParams);
    if (!userId) throw new ApiError(403, 'media_url_invalid', 'This upload link has expired; ask for new part URLs.');
    const upload = await openUpload(projectId, c.req.param('upload'));
    const expected = partNumber < upload.partCount ? upload.partSize : upload.size - upload.partSize * (upload.partCount - 1);
    const length = Number(c.req.header('content-length'));
    if (length !== expected) throw new ApiError(400, 'invalid_request', `part ${partNumber} must be ${expected} bytes`);
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, 'invalid_request', 'empty part');
    const etag = await blobs.uploadPart(projectKey(projectId, upload.file), upload.uploadId, partNumber, body);
    c.header('ETag', `"${etag}"`);
    return c.json({ etag });
  });

  /** Step 3: join the parts, read the video and start ingest. A repeat returns the project. */
  app.post('/projects/:id/upload/complete', async (c) => {
    const projectId = c.req.param('id');
    const request = CompleteUploadRequestSchema.parse(await c.req.json());
    const existing = await repo.read(projectId).catch(() => undefined);
    if (existing) return c.json(existing, 200);
    const upload = await openUpload(projectId, request.uploadId);
    const key = projectKey(projectId, upload.file);
    await blobs.completeMultipart(key, upload.uploadId, request.parts);
    const head = await blobs.head(key);
    let probed;
    try {
      if (head?.size !== upload.size) throw new ApiError(400, 'upload_incomplete', `expected ${upload.size} bytes, got ${head?.size ?? 0}`);
      probed = await media.probe({ projectId, file: upload.file });
    } catch (error) {
      // Nothing of a failed upload is kept: the creator starts again with a playable file.
      await repo.remove(projectId);
      await blobs.deletePrefix(`projects/${projectId}/`);
      throw error;
    }
    const names = [...new Set(upload.context.characters ?? [])];
    const project = await repo.create({
      id: projectId,
      version: 1,
      createdAt: new Date().toISOString(),
      source: { file: upload.file, proxy: 'proxy.mp4', originalName: upload.originalName, ...probed },
      context: {
        ...(upload.context.movieTitle ? { movieTitle: upload.context.movieTitle } : {}),
        ...(upload.context.sceneNote ? { sceneNote: upload.context.sceneNote } : {}),
        characters: names.map((name, i) => ({ id: `c-${i + 1}`, name, speakerLabels: [] })),
      },
      moments: [],
      themeId: PROJECT_THEME_ID,
      ingest: pendingIngest(),
      analysis: { status: 'idle', stages: [], models: {} },
    });
    await repo.removeUpload(projectId);
    ingest.start(c.get('userId'), project);
    return c.json(project, 201);
  });

  app.get('/projects/:id', async (c) => c.json(await repo.read(c.req.param('id'))));

  /** Signed access to every file of the project, for the Player, thumbnails and portraits. */
  app.get('/projects/:id/media', async (c) => {
    const id = c.req.param('id');
    await repo.read(id);
    return c.json(await signer.grant(c.get('userId'), id));
  });

  /** Editor autosave. Rejected with 409 unless based on the current version. */
  app.put('/projects/:id', async (c) => {
    const edit = ProjectEditSchema.parse(await c.req.json());
    const saved = await repo.save(c.req.param('id'), edit.version, (p) => {
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
  app.get('/projects/:id/history', async (c) => c.json(await repo.history(c.req.param('id'))));

  /**
   * Bring back an earlier version's moments, characters, format, bar, subtitles
   * and game review as a new version. The name and the look stay: projects use one look.
   */
  app.post('/projects/:id/history/:version/restore', async (c) => {
    const id = c.req.param('id');
    const { version } = ProjectEditSchema.pick({ version: true }).parse(await c.req.json());
    const old = await repo.readVersion(id, Number(c.req.param('version')));
    const saved = await repo.save(id, version, (p) => {
      p.moments = old.moments;
      p.context.characters = old.context.characters;
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

  /** Re-run ingest; steps whose inputs are unchanged are skipped. Returns the job (200 when one was already running). */
  app.post('/projects/:id/ingest', async (c) => {
    const { job, created } = await ingest.restart(c.get('userId'), c.req.param('id'));
    return c.json(job, created ? 202 : 200);
  });

  /** What analysis can do here: which keys are missing and which models run. */
  app.get('/analysis/config', (c) => {
    const info: AnalysisConfigInfo = {
      missingKeys: analysis.missingKeys(),
      models: analysis.config.models,
      autoAnalyze: analysis.config.autoAnalyze,
      replay: Boolean(analysis.config.replayDir),
    };
    return c.json(info);
  });

  /** Start analysis, or re-run it (`rerun: 'analyst'` keeps the transcript and scene notes). Returns the job. */
  app.post('/projects/:id/analyze', async (c) => {
    const missing = analysis.missingKeys();
    if (missing.length) throw new ApiError(400, 'missing_keys', `Add ${missing.join(', ')} to apps/server/.env`);
    const request = AnalyzeRequestSchema.parse(await c.req.json().catch(() => ({})));
    const { job, created } = await analysis.start(c.get('userId'), c.req.param('id'), request);
    return c.json(job, created ? 202 : 200);
  });

  /** Pass B for one moment. Returns a proposal; the editor decides whether to keep it. */
  app.post('/projects/:id/regenerate', async (c) => {
    const { moment, instruction, format } = RegenerateRequestSchema.parse(await c.req.json());
    return c.json(await analysis.regenerate(c.get('userId'), c.req.param('id'), moment, instruction, format));
  });

  /** Faces and subject on a move's frozen frame (cached per frame). A proposal: the editor places the card. */
  app.post('/projects/:id/regions', async (c) => {
    const { moment } = RegionsRequestSchema.parse(await c.req.json());
    return c.json(await analysis.regions(c.get('userId'), c.req.param('id'), moment));
  });

  /** Re-evaluate the bar for the editor's track (Pass C alone). A proposal: the project is not saved. */
  app.post('/projects/:id/evaluate', async (c) => {
    const request = EvaluateRequestSchema.parse(await c.req.json());
    return c.json(await analysis.evaluate(c.get('userId'), c.req.param('id'), request));
  });

  /** Spend on Regenerate, Re-evaluate and regions for this project. */
  app.get('/projects/:id/usage', async (c) => {
    const id = c.req.param('id');
    await repo.read(id);
    return c.json(await spend.usage.projectTotals(id));
  });

  app.delete('/projects/:id', async (c) => {
    const id = c.req.param('id');
    for (const kind of ['ingest', 'analysis', 'render'] as const) {
      const job = jobs.find(kind, id);
      if (job) throw new JobRunningError(`Wait for the ${kind === 'render' ? 'render' : kind} to finish before deleting.`, job);
    }
    await repo.read(id);
    await repo.remove(id);
    await blobs.deletePrefix(`projects/${id}/`);
    return c.body(null, 204);
  });

  /** Crops a portrait from one frame. Saves only the image (named by the crop, so a repeat writes the same file); the editor puts it on the character. */
  app.post('/projects/:id/portraits', async (c) => {
    const id = c.req.param('id');
    const request = PortraitRequestSchema.parse(await c.req.json());
    const project = await repo.read(id);
    const file = portraitFile(request);
    await media.portrait({ projectId: id, file: project.source.file, output: file, request, source: project.source });
    return c.json({ file });
  });

  /** Renders of the project, newest first. */
  app.get('/projects/:id/renders', async (c) => c.json(await renders.list(c.req.param('id'))));

  /** Render the project as saved at `version` (409 if it has moved on, so the editor saves first). A repeat while it runs returns it. */
  app.post('/projects/:id/renders', async (c) => {
    const request = RenderRequestSchema.parse(await c.req.json());
    const { render, created } = await renders.start(c.get('userId'), c.req.param('id'), request);
    return c.json(render, created ? 202 : 200);
  });

  app.post('/projects/:id/renders/:render/cancel', async (c) => {
    await renders.cancel(c.req.param('id'), c.req.param('render'));
    return c.json({ ok: true });
  });

  /** A signed link that downloads the finished MP4. */
  app.get('/projects/:id/renders/:render/download', async (c) => {
    const id = c.req.param('id');
    const job = await renders.finished(id, c.req.param('render'));
    const project = await repo.read(id);
    const grant = await signer.grant(c.get('userId'), id);
    const name = `${projectName(project).replace(/[^\w .()-]+/g, '').trim() || 'episode'} (${job.id}).mp4`;
    return c.json({ url: `${grantUrl(grant, job.file)}&download=${encodeURIComponent(name)}`, expiresAt: grant.expiresAt });
  });

  app.delete('/projects/:id/renders/:render', async (c) => {
    await renders.remove(c.req.param('id'), c.req.param('render'));
    return c.body(null, 204);
  });

  /** A blob as an HTTP response, with byte ranges so the browser can seek. */
  const serveBlob = async (c: { req: { header(name: string): string | undefined } }, key: string, name: string, download?: string) => {
    const head = await blobs.head(key);
    if (!head) throw new NotFoundError('not found');
    const etag = `"${head.version}"`;
    const headers = new Headers({
      'Content-Type': contentType(name),
      'Accept-Ranges': 'bytes',
      // Thumbnails change only when a re-ingest changes the shots; clients cache-bust with ?v=.
      'Cache-Control': 'no-cache',
      // So the browser revalidates instead of fetching again (the old static server sent Last-Modified).
      ETag: etag,
    });
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    // A range of a file that changed since the client's copy is the whole new file.
    const ifRange = c.req.header('if-range');
    const range = ifRange && ifRange !== etag ? undefined : parseRange(c.req.header('range'), head.size);
    if (download) headers.set('Content-Disposition', `attachment; filename="${download.replace(/["\\\r\n]/g, '')}"`);
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    const blob = await blobs.get(key, range);
    if (!blob) throw new NotFoundError('not found');
    headers.set('Content-Length', String(range ? range.length : blob.size));
    if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${blob.size}`);
    return new Response(blob.body, { status: range ? 206 : 200, headers });
  };

  // Media files, at signed URLs (see GET /projects/:id/media).
  app.get('/projects/:id/files/*', async (c) => {
    const id = c.req.param('id');
    const name = decodeURIComponent(c.req.path.slice(`${API_PREFIX}/projects/${id}/files/`.length));
    if (!SERVABLE_FILE.test(name)) throw new NotFoundError('not found');
    const query = new URL(c.req.url).searchParams;
    if (!(await signer.verify(projectScope(id), query))) throw new ApiError(403, 'media_url_invalid', 'This media link has expired; fetch new ones.');
    return serveBlob(c, projectKey(id, name), name, query.get('download') ?? undefined);
  });

  // The media service's side of the API (C3: presigned R2 URLs and the Worker's callback route).
  // Each URL is signed for one file or one task, so the service reaches nothing else.
  const mediaFile = async (c: { req: { path: string; url: string; param(name: 'id'): string } }, kind: 'in' | 'out') => {
    const id = c.req.param('id');
    const file = decodeURIComponent(c.req.path.slice(`${API_PREFIX}/media/${kind}/${id}/`.length));
    const scope = kind === 'in' ? mediaInScope(id, file) : mediaOutScope(id, file);
    if (!(await signer.verify(scope, new URL(c.req.url).searchParams))) throw new ApiError(403, 'media_url_invalid', 'This media service link is not valid.');
    return { id, file };
  };

  app.get('/media/in/:id/*', async (c) => {
    const { id, file } = await mediaFile(c, 'in');
    return serveBlob(c, projectKey(id, file), file);
  });

  app.put('/media/out/:id/*', async (c) => {
    const { id, file } = await mediaFile(c, 'out');
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, 'invalid_request', 'empty file');
    await blobs.put(projectKey(id, file), body);
    return c.json({ ok: true });
  });

  /** A media task's progress or result, from the media service. 404 tells it nobody is waiting any more. */
  app.post('/media/tasks/:task', async (c) => {
    const taskId = c.req.param('task');
    if (!(await signer.verify(mediaTaskScope(taskId), new URL(c.req.url).searchParams))) throw new ApiError(403, 'media_url_invalid', 'This callback link is not valid.');
    const event = MediaTaskEventSchema.parse(await c.req.json());
    if (event.id !== taskId || !deps.mediaTasks?.deliver(taskId, event)) throw new NotFoundError('no call is waiting for this task');
    return c.json({ ok: true });
  });

  /** The chess sounds that exist, with their lengths and signed URLs, for the Player and the renderer. */
  app.get('/sounds', async (c) => {
    const grant = await signer.soundsGrant(c.get('userId'));
    return c.json(await sounds.bank((file) => grantUrl(grant, file)));
  });

  app.get('/sounds/:file', async (c) => {
    const file = c.req.param('file');
    if (!SoundLibrary.servable(file)) throw new NotFoundError('not found');
    if (!(await signer.verify(SOUNDS_SCOPE, new URL(c.req.url).searchParams))) throw new ApiError(403, 'media_url_invalid', 'This sound link has expired.');
    return serveBlob(c, soundKey(file), file);
  });

  /**
   * Dev transport for live job updates: one `job` event per update, a `ping`
   * on connect and every 5 s. Clients read GET /jobs on (re)connect for the
   * snapshot. The Worker has no stream: Realtime Broadcast carries the same events.
   */
  const { events } = deps;
  if (events) {
    app.get('/events', (c) =>
      streamSSE(c, async (stream) => {
        // Send something at once so the stream opens now: until the first write nothing reaches the browser,
        // and a restart before then leaves it waiting forever behind the dev proxy. EventSource drops empty data.
        const ping = () => stream.writeSSE({ event: 'ping', data: 'ok' }).catch(() => undefined);
        await ping();
        const detach = events.subscribe(c.get('userId'), (job) => {
          void stream.writeSSE({ event: 'job', data: JSON.stringify(job) }).catch(() => undefined);
        });
        stream.onAbort(detach);
        while (!stream.aborted) {
          await stream.sleep(SSE_HEARTBEAT_MS);
          if (!stream.aborted) await ping();
        }
        detach();
      }),
    );
  }

  return app;
}
