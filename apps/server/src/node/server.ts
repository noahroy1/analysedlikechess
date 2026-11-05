import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StyleCorpusSchema } from '@als/schema';
import type { AnalysisConfig } from '../analysis/config.ts';
import type { Providers } from '../analysis/providers/index.ts';
import { AnalysisService } from '../analysis/service.ts';
import { MemoryIdempotencyStore } from '../api/idempotency.ts';
import { MediaSigner } from '../api/media-urls.ts';
import { createApp, fixedUser } from '../app.ts';
import { IngestService } from '../ingest/service.ts';
import { HttpMediaRunner } from '../media/http-runner.ts';
import type { ContainerType } from '../analysis/prices.ts';
import type { MediaRunner } from '../ports.ts';
import { RenderService, type RenderSplit } from '../render/renders.ts';
import { Spend } from '../spend.ts';
import { FsBlobStore } from './fs-blobs.ts';
import { FsProjectRepo } from './fs-repo.ts';
import { FsUsageLog } from './fs-usage.ts';
import { LocalEventBus } from './local-events.ts';
import { LocalJobRunner } from './local-jobs.ts';
import { makeProviders } from './providers.ts';
import { SoundLibrary } from './sounds.ts';

/** The one user of the local server until sign-in exists (C3). */
export const LOCAL_USER = 'local';

export interface NodeServerOptions {
  projectsDir: string;
  soundsDir: string;
  config: AnalysisConfig;
  /** This server's origin as the media service reaches it: it reads inputs, writes outputs and reports from there. */
  origin: string;
  /** The media service (`apps/media`); several spread render chunks over themselves. */
  mediaUrls: string[];
  /** How renders are split into chunks. */
  renderSplit?: RenderSplit;
  providers?: Providers;
  /** Signs media URLs. Absent: MEDIA_URL_SECRET, else a secret kept in the projects folder. */
  mediaSecret?: string;
  /** Monthly spend cap override (tests). */
  capUsd?: number;
  /** Wraps the media runner (tests). */
  wrapMedia?: (media: MediaRunner) => MediaRunner;
  /** Origins allowed to call across origins (tests; the editor here is same-origin through Vite). */
  corsOrigins?: readonly string[];
  /** Prices renders as if on this Container instance type (tests). */
  containerType?: ContainerType;
}

/**
 * The secret signing media URLs. Kept in the projects folder (a dot-folder the
 * project list ignores), so URLs survive a `node --watch` restart.
 */
async function mediaSecret(projectsDir: string): Promise<string> {
  if (process.env.MEDIA_URL_SECRET) return process.env.MEDIA_URL_SECRET;
  const file = join(projectsDir, '.secrets', 'media-url-secret');
  const existing = await readFile(file, 'utf8').catch(() => undefined);
  if (existing && existing.trim().length >= 32) return existing.trim();
  const secret = randomBytes(32).toString('hex');
  await mkdir(join(projectsDir, '.secrets'), { recursive: true, mode: 0o700 });
  await writeFile(file, secret, { mode: 0o600 });
  return secret;
}

/** The whole API on this machine: folders for data and media, jobs in this process, ffmpeg and Remotion in the media service. */
export async function createNodeServer(options: NodeServerOptions) {
  const { projectsDir, soundsDir, config } = options;
  const repo = new FsProjectRepo(projectsDir);
  const blobs = new FsBlobStore({ projectsDir, soundsDir });
  const events = new LocalEventBus();
  const jobs = new LocalJobRunner(events);
  const usage = new FsUsageLog(projectsDir);
  const spend = new Spend(usage, options.capUsd === undefined ? {} : { capUsd: options.capUsd });
  const signer = new MediaSigner(options.mediaSecret ?? (await mediaSecret(projectsDir)));
  const http = new HttpMediaRunner({ urls: options.mediaUrls, signer, blobs, origin: options.origin });
  const media = options.wrapMedia?.(http) ?? http;
  const sounds = new SoundLibrary(soundsDir);
  const style = StyleCorpusSchema.parse(JSON.parse(await readFile(config.styleCorpusPath, 'utf8')));
  const providers = options.providers ?? makeProviders(config);
  const analysis = new AnalysisService({ repo, blobs, media, jobs, usage, spend, providers, config, style });
  const ingest = new IngestService({ repo, blobs, media, jobs, onDone: (userId, id) => analysis.autoStart(userId, id) });
  const renders = new RenderService({ repo, blobs, media, jobs, usage, spend, sounds, signer, origin: options.origin, ...(options.renderSplit ? { split: options.renderSplit } : {}), ...(options.containerType ? { containerType: options.containerType } : {}) });
  const idempotency = new MemoryIdempotencyStore();
  const app = createApp({ repo, blobs, media, jobs, ingest, analysis, renders, sounds, signer, idempotency, spend, events, authenticate: fixedUser(LOCAL_USER), mediaTasks: http, ...(options.corsOrigins ? { corsOrigins: options.corsOrigins } : {}) });

  /** After a restart: fail interrupted renders and resume ingest and analysis (finished steps are cached). */
  const recover = async () => {
    const projects = await repo.list();
    await renders.recover(projects.map((p) => p.id));
    for (const project of projects) {
      if (project.ingest.status === 'pending' || project.ingest.status === 'running') await ingest.start(LOCAL_USER, project);
      else if (project.analysis.status === 'pending' || project.analysis.status === 'running') {
        void analysis.start(LOCAL_USER, project.id).catch((error: unknown) => console.warn(`analysis of ${project.id} not resumed:`, error));
      }
    }
  };

  return { app, repo, blobs, media, jobs, events, usage, spend, signer, sounds, analysis, ingest, renders, idempotency, recover };
}

export type NodeServer = Awaited<ReturnType<typeof createNodeServer>>;
