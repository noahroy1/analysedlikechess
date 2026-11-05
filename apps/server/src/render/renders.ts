import {
  ProjectSchema,
  RENDER_ENCODING,
  chunkRanges,
  episodeProps,
  gameReviewSec,
  presetSize,
  renderFile,
  type JobOf,
  type Project,
  type RenderJob,
  type RenderProps,
  type RenderRequest,
} from '@als/schema';
import { buildTimeline } from '@als/composition/timeline';
import { getTheme } from '@als/theme/themes';
import type { MediaSigner } from '../api/media-urls.ts';
import type { SoundLibrary } from '../node/sounds.ts';
import {
  JobRunningError,
  NotFoundError,
  VersionConflictError,
  projectKey,
  type BlobStore,
  type JobRunner,
  type MediaRunner,
  type ProjectRepo,
  type UsageLog,
} from '../ports.ts';
import type { Spend } from '../spend.ts';

const snapshotFile = (id: string) => `renders/${id}.json`;
/** A render's chunks while it runs; removed when it ends. */
const partsDir = (id: string) => `renders/${id}.parts/`;
const chunkFile = (id: string, index: number, ext: 'ts' | 'aac') => `${partsDir(id)}chunk-${String(index).padStart(4, '0')}.${ext}`;

/**
 * How a render is split by frame range, each chunk on its own media instance at
 * once (C0: one cloud instance took about 6 min for BB1, the Mac 2), then joined.
 */
export interface RenderSplit {
  /** At most this many chunks. */
  maxChunks: number;
  /** No chunk shorter than this, since each pays a fixed start (media download, browser, bundle). */
  minChunkFrames: number;
}

// TODO(open-decision): measured locally only; C4 sets the cloud values from real renders.
export const DEFAULT_RENDER_SPLIT: RenderSplit = { maxChunks: 4, minChunkFrames: 600 };

/** How many chunks a render of `frames` frames gets. */
export const chunkCount = (frames: number, split: RenderSplit) => Math.max(1, Math.min(split.maxChunks, Math.floor(frames / split.minChunkFrames)));

/** Chunk stages in the order they happen; a split render shows its slowest chunk's. */
const CHUNK_STAGES = ['Queued', 'Downloading media', 'Preparing the browser', 'Bundling', 'Rendering frames', 'Encoding', 'Uploading'];

export class RenderPresetError extends Error {}

export interface RenderDeps {
  repo: ProjectRepo;
  blobs: BlobStore;
  media: MediaRunner;
  jobs: JobRunner;
  usage: UsageLog;
  spend: Spend;
  sounds: SoundLibrary;
  signer: MediaSigner;
  /** The API's origin as the media service reaches it. It fetches the clip, portraits and sounds from it over signed URLs. */
  origin: string;
  split?: RenderSplit;
}

/**
 * Renders a saved version of a project to `renders/<id>.mp4`, one at a time,
 * with live progress. Each render reads a snapshot taken when it was started,
 * so edits made during a render never change its output.
 */
export class RenderService {
  private readonly deps: RenderDeps;

  constructor(deps: RenderDeps) {
    this.deps = deps;
    deps.jobs.register('render', (context) => this.run(context.job, context.userId, context.signal, context.report));
  }

  /** Renders a restart interrupted are marked failed; their partial files are removed. */
  async recover(projectIds: string[]): Promise<void> {
    for (const projectId of projectIds) {
      await this.deps.repo.editRenders(projectId, async (jobs) => {
        for (const job of jobs) {
          if (job.status !== 'pending' && job.status !== 'running') continue;
          Object.assign(job, { status: 'failed', error: 'The server stopped during this render.', finishedAt: now() });
          delete job.stage;
          await this.deps.blobs.deletePrefix(projectKey(projectId, partsDir(job.id)));
        }
      });
    }
  }

  /** Every render of a project, newest first, with the live one's progress. */
  async list(projectId: string): Promise<RenderJob[]> {
    const live = this.deps.jobs.find('render', projectId)?.state;
    return (await this.deps.repo.renders(projectId)).map((job) => (live?.id === job.id ? live : job)).toReversed();
  }

  /**
   * Starts a render of the project as saved at `request.version`. The same
   * version and size while it is still going returns that render (`created: false`).
   */
  async start(userId: string, projectId: string, request: RenderRequest): Promise<{ render: RenderJob; created: boolean }> {
    const { repo, blobs, jobs, spend } = this.deps;
    const running = jobs.find('render', projectId);
    if (running) {
      if (running.state.projectVersion === request.version && running.state.preset === request.preset) return { render: running.state, created: false };
      throw new JobRunningError('A render of this project is already running.', running);
    }
    const project = await repo.read(projectId);
    if (project.version !== request.version) throw new VersionConflictError(project.version);
    const size = presetSize(project.source, request.preset);
    if (!size) throw new RenderPresetError(`This clip does not scale evenly to ${request.preset}.`);
    await spend.check(userId);

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
    await blobs.put(projectKey(projectId, snapshotFile(id)), `${JSON.stringify(project, null, 2)}\n`);
    await repo.editRenders(projectId, (list) => {
      list.push(job);
    });
    const started = jobs.start('render', projectId, { userId, state: job });
    if (!started.created) {
      // Another request got in first; this one's entry goes again.
      await this.forget(projectId, id);
      if (started.job.state.projectVersion === request.version && started.job.state.preset === request.preset) return { render: started.job.state, created: false };
      throw new JobRunningError('A render of this project is already running.', started.job);
    }
    return { render: job, created: true };
  }

  /** Stops a queued or running render. */
  async cancel(projectId: string, id: string): Promise<void> {
    const job = await this.find(projectId, id);
    const live = this.deps.jobs.find('render', projectId);
    if (live?.state.id !== id) return;
    const wasPending = live.state.status === 'pending';
    this.deps.jobs.cancel(live.id);
    // A pending render never ran, so nothing else records that it stopped.
    if (wasPending && job.status === 'pending') await this.update(projectId, id, { status: 'cancelled', stage: undefined, finishedAt: now() });
  }

  /** Deletes a finished render's file, snapshot and entry. */
  async remove(projectId: string, id: string): Promise<void> {
    const job = await this.find(projectId, id);
    if (job.status === 'pending' || job.status === 'running') {
      const live = this.deps.jobs.find('render', projectId);
      if (live) throw new JobRunningError('Cancel the render before deleting it.', live);
    }
    await this.forget(projectId, id);
  }

  /** A finished render, for its download link. */
  async finished(projectId: string, id: string): Promise<RenderJob> {
    const job = await this.find(projectId, id);
    if (job.status !== 'done') throw new NotFoundError('That render has no file yet.');
    return job;
  }

  private async forget(projectId: string, id: string) {
    const { blobs, repo } = this.deps;
    await blobs.delete(projectKey(projectId, renderFile(id)));
    await blobs.delete(projectKey(projectId, snapshotFile(id)));
    await repo.editRenders(projectId, (jobs) => {
      const at = jobs.findIndex((j) => j.id === id);
      if (at >= 0) jobs.splice(at, 1);
    });
  }

  private async run(job: JobOf<'render'>, userId: string, signal: AbortSignal, onUpdate: (state: RenderJob) => void): Promise<void> {
    const { projectId } = job;
    const live: RenderJob = { ...job.state };
    const report = async (change: Partial<RenderJob>, persist = true) => {
      Object.assign(live, change);
      for (const key of Object.keys(change) as (keyof RenderJob)[]) if (change[key] === undefined) delete live[key];
      onUpdate({ ...live });
      if (persist) await this.update(projectId, live.id, change);
    };
    const started = performance.now();
    let containerSec: number | undefined;
    try {
      await report({ status: 'running', stage: 'Preparing', progress: 0 });
      const snapshot = await this.deps.blobs.get(projectKey(projectId, snapshotFile(live.id)));
      if (!snapshot) throw new Error('The render snapshot is missing.');
      const project = ProjectSchema.parse(JSON.parse(await new Response(snapshot.body).text()));
      const props = await this.props(userId, projectId, project);
      // Cancelled while getting ready: the media service only hears of an abort from now on.
      signal.throwIfAborted();
      const result = await this.renderChunks(projectId, live, props, project.source.width, signal, (change) => {
        // Stage changes are saved; frame-by-frame progress is only broadcast.
        void report(change, change.stage !== live.stage);
      });
      containerSec = result.seconds;
      await report({ status: 'done', stage: undefined, progress: 1, sizeBytes: result.sizeBytes, finishedAt: now() });
    } catch (error) {
      const cancelled = signal.aborted;
      if (!cancelled) console.error(`render ${projectId}/${live.id} failed:`, error);
      await report({
        status: cancelled ? 'cancelled' : 'failed',
        stage: undefined,
        finishedAt: now(),
        ...(cancelled ? {} : { error: error instanceof Error ? error.message : String(error) }),
      }).catch(() => undefined);
    } finally {
      // Renders cost nothing on this machine; container seconds (every chunk's, plus the join) are priced in C4.
      containerSec ??= (performance.now() - started) / 1000;
      await this.deps.usage.record({ userId, projectId, call: 'render', costUsd: 0, containerSec: Math.round(containerSec * 10) / 10 }).catch(() => undefined);
    }
  }

  /**
   * Renders the episode in frame-range chunks at once, then joins them. One
   * failed chunk stops the others. The chunks are deleted whatever happens.
   */
  private async renderChunks(
    projectId: string,
    job: RenderJob,
    props: RenderProps,
    sourceWidth: number,
    signal: AbortSignal,
    report: (change: Partial<RenderJob>) => void,
  ): Promise<{ sizeBytes: number; seconds: number }> {
    const { media, blobs } = this.deps;
    const { ranges, framesPerChunk } = chunkRanges(job.frames, chunkCount(job.frames, this.deps.split ?? DEFAULT_RENDER_SPLIT));
    const stopOthers = new AbortController();
    const chunkSignal = AbortSignal.any([signal, stopOthers.signal]);
    const progress = ranges.map(() => 0);
    const stages = ranges.map(() => 'Queued');
    // Rendering is most of the time; the join is the last tenth.
    const update = () => {
      const stage = CHUNK_STAGES[Math.min(...stages.map((s) => Math.max(0, CHUNK_STAGES.indexOf(s))))]!;
      report({ progress: 0.9 * (progress.reduce((a, b) => a + b, 0) / ranges.length), stage });
    };
    try {
      const chunks = await Promise.all(
        ranges.map((frameRange, i) =>
          media
            .renderChunk({
              projectId,
              props,
              scale: job.width / sourceWidth,
              frameRange,
              encoding: RENDER_ENCODING,
              video: chunkFile(job.id, i, 'ts'),
              audio: chunkFile(job.id, i, 'aac'),
              chunks: ranges.length,
              signal: chunkSignal,
              onProgress: ({ progress: p, stage }) => {
                progress[i] = p;
                if (stage) stages[i] = stage;
                update();
              },
            })
            .catch((error: unknown) => {
              stopOthers.abort(error);
              throw error;
            }),
        ),
      );
      signal.throwIfAborted();
      report({ progress: 0.9, stage: 'Joining' });
      const joined = await media.combine({
        projectId,
        videos: ranges.map((_, i) => chunkFile(job.id, i, 'ts')),
        audios: ranges.map((_, i) => chunkFile(job.id, i, 'aac')),
        output: job.file,
        fps: job.fps,
        framesPerChunk,
        durationInFrames: job.frames,
        encoding: RENDER_ENCODING,
        signal,
        onProgress: ({ progress: p }) => report({ progress: 0.9 + 0.09 * p, stage: 'Joining' }),
      });
      return { sizeBytes: joined.sizeBytes, seconds: chunks.reduce((sum, c) => sum + c.seconds, joined.seconds) };
    } finally {
      await blobs.deletePrefix(projectKey(projectId, partsDir(job.id))).catch(() => undefined);
    }
  }

  /** The snapshot as episode props, with every URL absolute and signed so the renderer's browser can load it. */
  private async props(userId: string, projectId: string, project: Project): Promise<RenderProps> {
    const { origin, signer, sounds } = this.deps;
    const grant = await signer.grant(userId, projectId);
    const fileUrl = (file: string) => `${origin}${grant.base}${file}?${grant.query}`;
    const soundGrant = await signer.soundsGrant(userId);
    const bank = await sounds.bank((file) => `${origin}${soundGrant.base}${file}?${soundGrant.query}`);
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

  private async find(projectId: string, id: string): Promise<RenderJob> {
    const job = (await this.deps.repo.renders(projectId)).find((j) => j.id === id);
    if (!job) throw new NotFoundError('render not found');
    return job;
  }

  private update(projectId: string, id: string, change: Partial<RenderJob>): Promise<void> {
    return this.deps.repo.editRenders(projectId, (jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return;
      Object.assign(job, change);
      for (const key of Object.keys(change) as (keyof RenderJob)[]) if (change[key] === undefined) delete job[key];
    });
  }
}

const now = () => new Date().toISOString();

/** `v<version>-<yyyymmdd>-<hhmmss>` in local time, so files sort and read naturally. */
export function renderId(version: number, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `v${version}-${date}-${time}`;
}
