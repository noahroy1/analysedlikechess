import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { CAPACITOR_ORIGINS, StyleCorpusSchema, type Project } from '@als/schema';
import corpus from '../../../style/corpus.json' with { type: 'json' };
import { loadAnalysisConfig } from './analysis/config.ts';
import { makeProviders } from './analysis/providers/make.ts';
import { handoffAnalyst, recorder, recordingsFrom } from './analysis/providers/replay.ts';
import { AnalysisService } from './analysis/service.ts';
import { isContainerType } from './analysis/prices.ts';
import { MediaSigner } from './api/media-urls.ts';
import { createApp, SIGNED_PATH } from './app.ts';
import { NotFoundError, projectKey } from './ports.ts';
import { IngestService } from './ingest/service.ts';
import { HttpMediaRunner } from './media/http-runner.ts';
import { DEFAULT_RENDER_SPLIT, RenderService } from './render/renders.ts';
import { Spend } from './spend.ts';
import { auth, TokenVerifier } from './auth.ts';
import { asUser, clientConnector, Db } from './db/db.ts';
import { PgIdempotencyStore } from './db/idempotency.ts';
import { PgProfileStore } from './db/profiles.ts';
import { PgProjectRepo } from './db/project-repo.ts';
import { PgSoundSource } from './db/sounds.ts';
import { PgUsageLog } from './db/usage-log.ts';
import { R2BlobStore } from './r2-blobs.ts';
import { RealtimeEventBus } from './realtime.ts';
import { BUNDLED_RECORDINGS } from './replay-fixtures.ts';
import { DEV_PREFIX, devSetName, r2Files } from './dev-files.ts';
import { WorkflowJobRunner, type JobParams } from './workflow-jobs.ts';
import { containerFetch, containerUrls, type MediaBindings } from './media-container.ts';
import type { Hyperdrive, R2Bucket, Workflow } from './workers.ts';

/** The Worker's bindings, vars and secrets (wrangler.jsonc; secrets with `wrangler secret`, `.dev.vars` in dev). */
export interface Env extends MediaBindings {
  MEDIA: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  JOBS: Workflow<JobParams>;
  SUPABASE_URL: string;
  /** Sends broadcasts (`sb_secret_…`). */
  SUPABASE_SECRET_KEY: string;
  /** Signs media URLs; at least 32 characters. */
  MEDIA_URL_SECRET: string;
  /** Dev: the local media service (`apps/media`; comma-separated for several, render chunks spread over them). Absent: the Container bindings (MEDIA_TASKS, MEDIA_QUICK). */
  MEDIA_URL?: string;
  /** How renders split (DEFAULT_RENDER_SPLIT when absent): at most this many chunks, of at least this many frames. */
  RENDER_CHUNKS?: string;
  RENDER_CHUNK_MIN_FRAMES?: string;
  /** This API's origin as the media service reaches it. */
  API_ORIGIN: string;
  /** The web app's origins, comma-separated (C4: one per environment). The mobile app's are always allowed. */
  WEB_ORIGINS?: string;
  /** The Container instance type renders run on, which prices them. Absent: a local media service, at $0. */
  MEDIA_INSTANCE_TYPE?: string;
  /** Names a bundled set of recordings to replay instead of calling providers (`dialogue`). */
  ANALYSIS_REPLAY_DIR?: string;
  /** Dev only: records every raw provider response under R2 `dev/record/<name>/`. */
  ANALYSIS_RECORD_DIR?: string;
  /** Dev only: the LLM calls become hand-offs under R2 `dev/handoff/<name>/`. */
  ANALYST_HANDOFF_DIR?: string;
  /** Dev only: `true` adds the seeding and dev-file routes, and allows recording and hand-offs (never set in a deployed environment). */
  DEV_ROUTES?: string;
  [key: string]: unknown;
}

/**
 * Promises to keep alive past the current request or Workflow run (live
 * updates sent while a job reports). The entry points collect them.
 */
export const keepAlive = new AsyncLocalStorage<(promise: Promise<unknown>) => void>();

/** The whole API on Cloudflare and Supabase: built once per isolate (bindings don't change within one). */
export function buildCloud(env: Env) {
  const db = new Db(clientConnector(env.HYPERDRIVE.connectionString));
  const repo = new PgProjectRepo(db);
  const blobs = new R2BlobStore(env.MEDIA);
  const events = new RealtimeEventBus({
    supabaseUrl: env.SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
    waitUntil: (promise) => keepAlive.getStore()?.(promise),
  });
  const jobs = new WorkflowJobRunner({ db, events, binding: env.JOBS });
  const usage = new PgUsageLog(db);
  const spend = new Spend(usage, { profiles: new PgProfileStore(db) });
  const signer = new MediaSigner(env.MEDIA_URL_SECRET);
  // Callbacks are off: one would land on whichever isolate answers, so the waiting step polls instead.
  const media = new HttpMediaRunner({
    ...(env.MEDIA_URL ? { urls: env.MEDIA_URL.split(',').map((u) => u.trim()).filter(Boolean) } : { ...containerUrls(), fetch: containerFetch(env) }),
    signer,
    blobs,
    origin: env.API_ORIGIN,
    callbacks: false,
  });
  const sounds = new PgSoundSource(db);

  const vars = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  // The style corpus is bundled; the path is only read on Node.
  const config = loadAnalysisConfig({ ...vars, STYLE_CORPUS: 'bundled' });
  const replay = config.replayDir ? BUNDLED_RECORDINGS[config.replayDir] : undefined;
  if (config.replayDir && !replay) throw new Error(`ANALYSIS_REPLAY_DIR names no bundled recordings: ${config.replayDir}`);
  // Dev only: recordings and hand-offs are R2 prefixes (dev/record/<name>/, dev/handoff/<name>/), moved with `pnpm dev:files`.
  const dev = env.DEV_ROUTES === 'true';
  if ((config.recordDir || config.handoffDir) && !dev) throw new Error('ANALYSIS_RECORD_DIR and ANALYST_HANDOFF_DIR are dev only (DEV_ROUTES)');
  const providers = makeProviders(config, {
    ...(replay ? { replay: recordingsFrom(replay, `the bundled ${config.replayDir} recordings`), replayDelayMs: Number(vars.ANALYSIS_REPLAY_DELAY_MS ?? 0) } : {}),
    ...(config.recordDir ? { record: recorder(r2Files(env.MEDIA, `${DEV_PREFIX}record/${devSetName(config.recordDir)}/`)) } : {}),
    ...(config.handoffDir ? { handoff: handoffAnalyst(r2Files(env.MEDIA, `${DEV_PREFIX}handoff/${devSetName(config.handoffDir)}/`)) } : {}),
  });
  const style = StyleCorpusSchema.parse(corpus);

  const analysis = new AnalysisService({ repo, blobs, media, jobs, usage, spend, providers, config, style });
  const ingest = new IngestService({ repo, blobs, media, jobs, onDone: (userId, id) => analysis.autoStart(userId, id) });
  const containerType = env.MEDIA_INSTANCE_TYPE;
  if (containerType !== undefined && !isContainerType(containerType)) throw new Error(`MEDIA_INSTANCE_TYPE is not a Container instance type: ${containerType}`);
  const split = {
    ...DEFAULT_RENDER_SPLIT,
    ...(env.RENDER_CHUNKS ? { maxChunks: Number(env.RENDER_CHUNKS) } : {}),
    ...(env.RENDER_CHUNK_MIN_FRAMES ? { minChunkFrames: Number(env.RENDER_CHUNK_MIN_FRAMES) } : {}),
  };
  const renders = new RenderService({ repo, blobs, media, jobs, usage, spend, sounds, signer, origin: env.API_ORIGIN, split, ...(containerType ? { containerType } : {}) });
  const verifier = new TokenVerifier({ supabaseUrl: env.SUPABASE_URL });
  const app = createApp({
    repo,
    blobs,
    media,
    jobs,
    ingest,
    analysis,
    renders,
    sounds,
    signer,
    idempotency: new PgIdempotencyStore(db),
    spend,
    authenticate: auth(verifier, { skip: (path) => SIGNED_PATH.test(path) }),
    runAs: (userId, work) => asUser(userId, work),
    corsOrigins: [...CAPACITOR_ORIGINS, ...(env.WEB_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)],
  });
  if (dev) {
    /**
     * Dev seeding (`pnpm seed:sample`, `pnpm seed:moments`): sets parts of a
     * project's document the editor API doesn't (transcript, scene notes,
     * characters, moves), as the seed scripts once wrote project.json. The
     * owner only, like every route; never the source, ingest or analysis state.
     */
    const KEPT = ['id', 'version', 'createdAt', 'source', 'ingest', 'analysis'] as const;
    app.put('/dev/projects/:id/seed', async (c) => {
      const fields = z.record(z.string(), z.unknown()).parse(await c.req.json());
      for (const key of KEPT) delete fields[key];
      // The repo validates the merged document with ProjectSchema.
      const project = await repo.update(c.req.param('id'), (p) => ({ ...p, ...fields }) as Project);
      return c.json(project);
    });
    /** Replaces one of the owner's project files (sound-checks swaps in a silent proxy, as it once did on disk). */
    app.put('/dev/projects/:id/files/*', async (c) => {
      const id = c.req.param('id');
      await repo.read(id);
      const file = decodeURIComponent(c.req.path.slice(`/api/v1/dev/projects/${id}/files/`.length));
      await blobs.put(projectKey(id, file), new Uint8Array(await c.req.arrayBuffer()));
      return c.json({ ok: true });
    });
    /**
     * Dev files in R2 under `dev/` (recordings, hand-offs), for `pnpm dev:files`:
     * list a prefix, read or write one key. Nothing outside `dev/`.
     */
    const devKey = (path: string) => {
      const key = decodeURIComponent(path.slice('/api/v1/dev/files/'.length));
      if (!key.startsWith(DEV_PREFIX) || key.split('/').some((part) => part === '..' || part === '')) throw new NotFoundError('not a dev file');
      return key;
    };
    app.get('/dev/files', async (c) => {
      const prefix = c.req.query('prefix') ?? DEV_PREFIX;
      if (!prefix.startsWith(DEV_PREFIX)) throw new NotFoundError('not a dev prefix');
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.MEDIA.list({ prefix, ...(cursor ? { cursor } : {}) });
        keys.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return c.json({ keys });
    });
    app.get('/dev/files/*', async (c) => {
      const object = await env.MEDIA.get(devKey(c.req.path));
      if (!object) throw new NotFoundError('no such dev file');
      return c.body(await object.text(), 200, { 'Content-Type': 'application/json' });
    });
    app.put('/dev/files/*', async (c) => {
      await env.MEDIA.put(devKey(c.req.path), await c.req.text());
      return c.json({ ok: true });
    });
  }
  return { app, db, repo, blobs, jobs, events, usage, spend, signer, sounds, analysis, ingest, renders };
}

export type Cloud = ReturnType<typeof buildCloud>;
