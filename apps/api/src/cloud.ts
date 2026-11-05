import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { StyleCorpusSchema, type Project } from '@als/schema';
import corpus from '../../../style/corpus.json' with { type: 'json' };
import { loadAnalysisConfig } from '../../server/src/analysis/config.ts';
import { makeProviders } from '../../server/src/analysis/providers/make.ts';
import { recordingsFrom } from '../../server/src/analysis/providers/replay.ts';
import { AnalysisService } from '../../server/src/analysis/service.ts';
import { MediaSigner } from '../../server/src/api/media-urls.ts';
import { createApp, SIGNED_PATH } from '../../server/src/app.ts';
import { IngestService } from '../../server/src/ingest/service.ts';
import { HttpMediaRunner } from '../../server/src/media/http-runner.ts';
import { RenderService } from '../../server/src/render/renders.ts';
import { Spend } from '../../server/src/spend.ts';
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
import { WorkflowJobRunner, type JobParams } from './workflow-jobs.ts';
import type { Hyperdrive, R2Bucket, Workflow } from './workers.ts';

/** The Worker's bindings, vars and secrets (wrangler.jsonc; secrets with `wrangler secret`, `.dev.vars` in dev). */
export interface Env {
  MEDIA: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  JOBS: Workflow<JobParams>;
  SUPABASE_URL: string;
  /** Sends broadcasts (`sb_secret_…`). */
  SUPABASE_SECRET_KEY: string;
  /** Signs media URLs; at least 32 characters. */
  MEDIA_URL_SECRET: string;
  /** The media service (dev: the local `apps/media` process). */
  MEDIA_URL: string;
  /** This API's origin as the media service reaches it. */
  API_ORIGIN: string;
  /** Names a bundled set of recordings to replay instead of calling providers (`dialogue`). */
  ANALYSIS_REPLAY_DIR?: string;
  /** Dev only: `true` adds the seeding route (never set in a deployed environment). */
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
  const media = new HttpMediaRunner({ urls: [env.MEDIA_URL], signer, blobs, origin: env.API_ORIGIN, callbacks: false });
  const sounds = new PgSoundSource(db);

  const vars = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  // The style corpus is bundled; the path is only read on Node.
  const config = loadAnalysisConfig({ ...vars, STYLE_CORPUS: 'bundled' });
  const replay = config.replayDir ? BUNDLED_RECORDINGS[config.replayDir] : undefined;
  if (config.replayDir && !replay) throw new Error(`ANALYSIS_REPLAY_DIR names no bundled recordings: ${config.replayDir}`);
  const providers = makeProviders(
    config,
    replay ? { replay: recordingsFrom(replay, `the bundled ${config.replayDir} recordings`), replayDelayMs: Number(vars.ANALYSIS_REPLAY_DELAY_MS ?? 0) } : {},
  );
  const style = StyleCorpusSchema.parse(corpus);

  const analysis = new AnalysisService({ repo, blobs, media, jobs, usage, spend, providers, config, style });
  const ingest = new IngestService({ repo, blobs, media, jobs, onDone: (userId, id) => analysis.autoStart(userId, id) });
  const renders = new RenderService({ repo, blobs, media, jobs, usage, spend, sounds, signer, origin: env.API_ORIGIN });
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
  });
  if (env.DEV_ROUTES === 'true') {
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
  }
  return { app, db, repo, blobs, jobs, events, usage, spend, signer, sounds, analysis, ingest, renders };
}

export type Cloud = ReturnType<typeof buildCloud>;
