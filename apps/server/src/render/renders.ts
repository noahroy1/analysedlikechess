import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ProjectSchema,
  RenderJobSchema,
  episodeProps,
  gameReviewSec,
  presetSize,
  renderFile,
  type Project,
  type RenderJob,
  type RenderProps,
  type RenderRequest,
  type SoundBank,
} from '@als/schema';
import { buildTimeline } from '@als/composition/timeline';
import { getTheme } from '@als/theme/themes';
import { JobQueue } from '../jobs.ts';
import type { SoundLibrary } from '../media/sounds.ts';
import { VersionConflictError, type ProjectStore } from '../projects/store.ts';
import { EpisodeBundle } from './bundle.ts';

/** Must match EPISODE_COMPOSITION in packages/composition/src/render-entry.tsx. */
const COMPOSITION_ID = 'Episode';

const MANIFEST = 'renders/renders.json';
const snapshotFile = (id: string) => `renders/${id}.json`;

/**
 * Quality-first H.264 and AAC, ready for YouTube. Frames are captured raw when
 * the bundled ffmpeg supports shared memory, else as near-lossless JPEGs.
 */
const ENCODING = {
  codec: 'h264',
  crf: 18,
  x264Preset: 'medium',
  audioCodec: 'aac',
  audioBitrate: '320k',
  colorSpace: 'bt709',
  jpegQuality: 95,
} as const;

/** Time allowed for the clip and sounds to load into a frame. A long source can take a while to open. */
const LOAD_TIMEOUT_MS = 120_000;

export class RenderBusyError extends Error {}
export class RenderNotFoundError extends Error {}
export class RenderPresetError extends Error {}

export interface RenderDeps {
  store: ProjectStore;
  sounds: SoundLibrary;
  /** This server's own origin. The renderer's browser loads the clip, portraits and sounds from it. */
  origin: string;
  bundle?: EpisodeBundle;
}

/**
 * Renders a saved version of a project to `renders/<id>.mp4`, one project at a
 * time, with live progress. Each render reads a snapshot taken when it was
 * started, so edits made during a render never change its output.
 */
export class RenderService {
  readonly queue: JobQueue<RenderJob>;
  private readonly deps: RenderDeps & { bundle: EpisodeBundle };
  private readonly cancels = new Map<string, () => void>();
  /** Per-project manifest writes, one after another. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private browser: Promise<unknown> | undefined;

  constructor(deps: RenderDeps) {
    this.deps = { ...deps, bundle: deps.bundle ?? new EpisodeBundle() };
    this.queue = new JobQueue<RenderJob>(
      (projectId, onUpdate) => this.run(projectId, onUpdate),
      (job) => `${job.status}:${job.stage ?? ''}`,
    );
  }

  /** Renders a restart interrupted are marked failed; their partial files are removed. */
  async recover(projectIds: string[]): Promise<void> {
    for (const projectId of projectIds) {
      await this.edit(projectId, async (jobs) => {
        for (const job of jobs) {
          if (job.status !== 'pending' && job.status !== 'running') continue;
          Object.assign(job, { status: 'failed', error: 'The server stopped during this render.', finishedAt: now() });
          await rm(this.deps.store.file(projectId, tmpFile(job.id)), { force: true });
        }
      });
    }
  }

  /** Every render of a project, newest first. */
  async list(projectId: string): Promise<RenderJob[]> {
    await this.deps.store.read(projectId);
    // Progress is only broadcast, never written, so a running render's entry comes from the queue.
    const live = new Map(this.queue.snapshot().flatMap(({ projectId: id, state }) => (id === projectId ? [[state.id, state]] : [])));
    return (await this.readManifest(projectId)).map((job) => live.get(job.id) ?? job).toReversed();
  }

  /** Queues a render of the project as saved at `request.version`. */
  async start(projectId: string, request: RenderRequest): Promise<RenderJob> {
    if (this.queue.has(projectId)) throw new RenderBusyError('A render of this project is already running.');
    const project = await this.deps.store.read(projectId);
    if (project.version !== request.version) throw new VersionConflictError(project.version);
    const size = presetSize(project.source, request.preset);
    if (!size) throw new RenderPresetError(`This clip does not scale evenly to ${request.preset}.`);

    const { fps, durationSec } = project.source;
    const id = renderId(project.version, new Date());
    const job: RenderJob = {
      id,
      projectVersion: project.version,
      preset: request.preset,
      width: size.width,
      height: size.height,
      fps,
      frames: buildTimeline(project.moments, fps, durationSec, gameReviewSec(getTheme(project.themeId))).outFrames,
      status: 'pending',
      stage: 'Queued',
      progress: 0,
      createdAt: now(),
      file: renderFile(id),
    };
    await mkdir(dirname(this.deps.store.file(projectId, job.file)), { recursive: true });
    await writeFile(this.deps.store.file(projectId, snapshotFile(job.id)), `${JSON.stringify(project, null, 2)}\n`);
    await this.edit(projectId, (jobs) => {
      jobs.push(job);
    });
    this.queue.enqueue(projectId);
    return job;
  }

  /** Stops a queued or running render. */
  async cancel(projectId: string, id: string): Promise<void> {
    const job = await this.find(projectId, id);
    if (job.status === 'running') this.cancels.get(projectId)?.();
    else if (job.status === 'pending') await this.update(projectId, id, { status: 'cancelled', stage: undefined, finishedAt: now() });
  }

  /** Deletes a finished render's file, snapshot and entry. */
  async remove(projectId: string, id: string): Promise<void> {
    const job = await this.find(projectId, id);
    if (job.status === 'pending' || job.status === 'running') throw new RenderBusyError('Cancel the render before deleting it.');
    await rm(this.deps.store.file(projectId, job.file), { force: true });
    await rm(this.deps.store.file(projectId, snapshotFile(id)), { force: true });
    await this.edit(projectId, (jobs) => {
      jobs.splice(jobs.findIndex((j) => j.id === id), 1);
    });
  }

  /** Shows the finished file in Finder (or the folder in the system's file manager). */
  async reveal(projectId: string, id: string): Promise<void> {
    const job = await this.find(projectId, id);
    if (job.status !== 'done') throw new RenderNotFoundError('That render has no file yet.');
    const path = this.deps.store.file(projectId, job.file);
    const [command, args] = process.platform === 'darwin' ? ['open', ['-R', path]] : ['xdg-open', [dirname(path)]];
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', (error) => console.error(`could not open ${path}:`, error)).unref();
  }

  /** Bundles and opens the browser ahead of the first render, so it starts sooner. */
  warmUp(): void {
    void this.ensureBrowser().catch((error: unknown) => console.warn('render browser not ready:', error));
    void this.deps.bundle.serveUrl().catch((error: unknown) => console.warn('render bundle failed:', error));
  }

  private async run(projectId: string, onUpdate: (job: RenderJob) => void): Promise<void> {
    const job = (await this.readManifest(projectId)).find((j) => j.status === 'pending');
    if (!job) return;
    const { store } = this.deps;
    const output = store.file(projectId, job.file);
    const tmp = store.file(projectId, tmpFile(job.id));
    const live = { ...job };
    const report = async (change: Partial<RenderJob>, persist = true) => {
      Object.assign(live, change);
      onUpdate({ ...live });
      if (persist) await this.update(projectId, job.id, change);
    };

    let cancelled = false;
    try {
      const { makeCancelSignal, renderMedia, selectComposition } = await import('@remotion/renderer');
      const { cancelSignal, cancel } = makeCancelSignal();
      this.cancels.set(projectId, () => {
        cancelled = true;
        cancel();
      });

      await report({ status: 'running', stage: 'Preparing the browser', progress: 0 });
      await this.ensureBrowser();
      if (cancelled) throw new CancelledError();

      await report({ stage: 'Bundling' });
      const serveUrl = await this.deps.bundle.serveUrl();
      if (cancelled) throw new CancelledError();

      const snapshot = ProjectSchema.parse(JSON.parse(await readFile(store.file(projectId, snapshotFile(job.id)), 'utf8')));
      const inputProps = await this.props(projectId, snapshot);
      const shared = { serveUrl, inputProps, timeoutInMilliseconds: LOAD_TIMEOUT_MS, chromiumOptions, logLevel: 'warn' } as const;
      const composition = await selectComposition({ ...shared, id: COMPOSITION_ID });

      await report({ stage: 'Rendering frames', frames: composition.durationInFrames });
      await renderMedia({
        ...shared,
        ...ENCODING,
        composition,
        scale: job.width / snapshot.source.width,
        outputLocation: tmp,
        cancelSignal,
        onProgress: ({ progress, stitchStage, renderedFrames }) => {
          const stage = renderedFrames < composition.durationInFrames ? 'Rendering frames' : stitchStage === 'muxing' ? 'Adding audio' : 'Encoding';
          void report({ progress: Math.min(progress, 0.99), stage }, false);
        },
        onBrowserLog: (log) => {
          if (log.type === 'error') console.warn(`render ${projectId}/${job.id}:`, log.text);
        },
      });
      await rename(tmp, output);
      const { size } = await stat(output);
      await report({ status: 'done', stage: undefined, progress: 1, sizeBytes: size, finishedAt: now() });
    } catch (error) {
      await rm(tmp, { force: true });
      if (!cancelled) console.error(`render ${projectId}/${job.id} failed:`, error);
      await report({
        status: cancelled ? 'cancelled' : 'failed',
        stage: undefined,
        finishedAt: now(),
        ...(cancelled ? {} : { error: error instanceof Error ? error.message : String(error) }),
      }).catch(() => undefined);
    } finally {
      this.cancels.delete(projectId);
    }
  }

  /** The snapshot as episode props, with every URL absolute so the renderer's browser can load it. */
  private async props(projectId: string, project: Project): Promise<RenderProps> {
    const { origin, sounds } = this.deps;
    const fileUrl = (file: string) => `${origin}/api/projects/${projectId}/files/${file}`;
    const bank: SoundBank = Object.fromEntries(
      Object.entries(await sounds.bank()).map(([id, sound]) => [id, { ...sound, src: `${origin}${sound.src}` }]),
    );
    const { source } = project;
    return {
      ...episodeProps(
        { ...project, characters: project.context.characters, durationSec: source.durationSec },
        // The original file, not the proxy: the render is full quality.
        { src: fileUrl(source.file), theme: getTheme(project.themeId), fileUrl, sounds: bank },
      ),
      fps: source.fps,
      width: source.width,
      height: source.height,
    };
  }

  private ensureBrowser(): Promise<unknown> {
    // Downloads Chrome Headless Shell the first time.
    this.browser ??= import('@remotion/renderer').then(({ ensureBrowser }) => ensureBrowser());
    this.browser.catch(() => {
      this.browser = undefined;
    });
    return this.browser;
  }

  private async find(projectId: string, id: string): Promise<RenderJob> {
    const job = (await this.readManifest(projectId)).find((j) => j.id === id);
    if (!job) throw new RenderNotFoundError('render not found');
    return job;
  }

  private update(projectId: string, id: string, change: Partial<RenderJob>): Promise<void> {
    return this.edit(projectId, (jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return;
      Object.assign(job, change);
      for (const key of Object.keys(change) as (keyof RenderJob)[]) if (change[key] === undefined) delete job[key];
    });
  }

  private async readManifest(projectId: string): Promise<RenderJob[]> {
    const raw = await readFile(this.deps.store.file(projectId, MANIFEST), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    });
    return RenderJobSchema.array().parse(JSON.parse(raw));
  }

  private edit(projectId: string, change: (jobs: RenderJob[]) => void | Promise<void>): Promise<void> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const jobs = await this.readManifest(projectId);
      await change(jobs);
      const path = this.deps.store.file(projectId, MANIFEST);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, `${JSON.stringify(jobs, null, 2)}\n`);
      await rename(`${path}.tmp`, path);
    });
    this.locks.set(projectId, next);
    return next;
  }
}

class CancelledError extends Error {}

/**
 * The renderer's browser loads the clip from this server, a different origin
 * from the bundle it is served. It is a local, single-purpose browser, so
 * cross-origin checks are off rather than opening the server to every page with CORS.
 */
const chromiumOptions = { disableWebSecurity: true };

const tmpFile = (id: string) => `renders/${id}.tmp.mp4`;
const now = () => new Date().toISOString();

/** `v<version>-<yyyymmdd>-<hhmmss>` in local time, so files sort and read naturally. */
export function renderId(version: number, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `v${version}-${date}-${time}`;
}
