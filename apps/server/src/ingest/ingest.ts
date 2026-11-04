import { createHash } from 'node:crypto';
import { z } from 'zod';
import { shotThumbnailFile, type Ingest, type Project, type Stage } from '@als/schema';
import { CUT_DETECTION } from '../media/cuts.ts';
import { PROXY, THUMB_WIDTH } from '../media/settings.ts';
import { projectKey, type BlobStore, type MediaRunner, type ProjectRepo } from '../ports.ts';

export const INGEST_STAGES = ['hash', 'probe', 'proxy', 'audio', 'shots', 'thumbnails'] as const;
type StageName = (typeof INGEST_STAGES)[number];

/** Bump a step's version when its command changes, so cached outputs are rebuilt. */
const STEP_VERSION: Record<Exclude<StageName, 'hash'>, number> = {
  probe: 1,
  proxy: 1,
  audio: 1,
  shots: 1,
  thumbnails: 1,
};

export const AUDIO_FILE = 'audio.wav';

export const pendingIngest = (): Ingest => ({
  status: 'pending',
  stages: INGEST_STAGES.map((name) => ({ name, status: 'pending' })),
});

const cacheKey = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const HashOutputSchema = z.object({ sourceHash: z.string().min(1) });

export interface IngestDeps {
  repo: ProjectRepo;
  blobs: BlobStore;
  media: MediaRunner;
}

/** The source's content hash, once ingest has computed it. Analysis and region caches key on it. */
export async function sourceHash(repo: ProjectRepo, projectId: string): Promise<string> {
  const entry = await repo.getStage(projectId, 'ingest', 'hash');
  const parsed = HashOutputSchema.safeParse(entry?.output);
  if (!parsed.success) throw new Error('Ingest has not hashed the source yet');
  return parsed.data.sourceHash;
}

/**
 * Stage 1 of the pipeline: hash, probe, proxy, audio, cuts and shot thumbnails.
 * Each step is skipped when its inputs are unchanged and its outputs exist.
 */
export async function runIngest({ repo, blobs, media }: IngestDeps, id: string, onUpdate: (ingest: Ingest) => void): Promise<Ingest> {
  let project = await repo.read(id);
  const file = (name: string) => ({ projectId: id, file: name });
  const exists = async (name: string) => (await blobs.head(projectKey(id, name))) !== undefined;
  const ingest: Ingest = { status: 'running', stages: pendingIngest().stages };
  const stageOf = (name: StageName) => ingest.stages.find((s) => s.name === name)!;

  const save = async () => {
    project = await repo.update(id, (p) => {
      p.ingest = structuredClone(ingest);
    });
  };
  await save();
  onUpdate(ingest);

  /** Runs one step unless its key matches the last run and its outputs exist. Returns whether it ran. */
  const step = async (
    name: StageName,
    key: string,
    outputsExist: () => Promise<boolean>,
    work: (progress: (p: number) => void) => Promise<unknown>,
  ): Promise<void> => {
    const stage: Stage = stageOf(name);
    const cached = await repo.getStage(id, 'ingest', name);
    if (cached?.key === key && (await outputsExist())) {
      stage.status = 'cached';
      onUpdate(ingest);
      return;
    }
    stage.status = 'running';
    stage.progress = 0;
    await save();
    onUpdate(ingest);
    const started = performance.now();
    const output = await work((p) => {
      stage.progress = p;
      onUpdate(ingest);
    });
    stage.status = 'done';
    delete stage.progress;
    stage.durationMs = Math.round(performance.now() - started);
    await repo.putStage(id, 'ingest', name, key, output ?? null);
    await save();
    onUpdate(ingest);
  };

  try {
    // Re-hash only when the stored file changed; hashing is the cost of a re-run.
    const source = await blobs.head(projectKey(id, project.source.file));
    if (!source) throw new Error('The source file is missing');
    await step(
      'hash',
      cacheKey('hash', source.size, source.version),
      async () => HashOutputSchema.safeParse((await repo.getStage(id, 'ingest', 'hash'))?.output).success,
      async (progress) => ({ sourceHash: await media.hash(file(project.source.file), progress) }),
    );
    const hash = await sourceHash(repo, id);

    await step(
      'probe',
      cacheKey('probe', STEP_VERSION.probe, hash),
      async () => true,
      async () => {
        const result = await media.probe(file(project.source.file));
        project = await repo.update(id, (p) => {
          p.source = { ...p.source, ...result };
        });
      },
    );
    const { fps, durationSec, hasAudio } = project.source;

    const proxyKey = cacheKey('proxy', STEP_VERSION.proxy, hash, fps, PROXY);
    await step(
      'proxy',
      proxyKey,
      () => exists(project.source.proxy),
      (progress) => media.proxy({ ...file(project.source.file), output: project.source.proxy, fps, durationSec }, progress),
    );

    if (hasAudio) {
      await step(
        'audio',
        cacheKey('audio', STEP_VERSION.audio, hash),
        () => exists(AUDIO_FILE),
        (progress) => media.audio({ ...file(project.source.file), output: AUDIO_FILE, durationSec }, progress),
      );
    } else {
      await blobs.delete(projectKey(id, AUDIO_FILE));
      stageOf('audio').status = 'skipped';
      onUpdate(ingest);
    }

    await step(
      'shots',
      cacheKey('shots', STEP_VERSION.shots, proxyKey, CUT_DETECTION),
      async () => project.shots !== undefined,
      async (progress) => {
        const shots = await media.shots({ ...file(project.source.proxy), durationSec }, progress);
        project = await repo.update(id, (p: Project) => {
          p.shots = shots;
        });
      },
    );

    const shots = project.shots ?? [];
    await step(
      'thumbnails',
      cacheKey('thumbnails', STEP_VERSION.thumbnails, proxyKey, shots, THUMB_WIDTH),
      async () => (await Promise.all(shots.map((_, i) => exists(shotThumbnailFile(i))))).every(Boolean),
      (progress) => media.thumbnails({ ...file(project.source.proxy), shots }, progress),
    );

    ingest.status = 'done';
  } catch (error) {
    const running = ingest.stages.find((s) => s.status === 'running');
    const message = error instanceof Error ? error.message : String(error);
    if (running) {
      running.status = 'error';
      running.error = message;
      delete running.progress;
    }
    ingest.status = 'error';
    ingest.error = message;
  }
  await save();
  onUpdate(ingest);
  return ingest;
}
