import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { shotThumbnailFile, type Ingest, type Stage } from '@als/schema';
import { CUT_DETECTION, detectCuts, parseScdet, shotsFromCuts } from '../media/cuts.ts';
import { probe } from '../media/probe.ts';
import { ffmpeg } from '../media/run.ts';
import type { ProjectStore } from '../projects/store.ts';

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

export const PROXY = { maxHeight: 720, crf: 23, preset: 'veryfast', audioKbps: 128 };
const THUMB_WIDTH = 320;
const THUMB_CONCURRENCY = 4;

/** `ingest.json`: what each step last ran on, so unchanged steps are skipped. */
const ManifestSchema = z.object({
  sourceHash: z.string(),
  sourceSize: z.number(),
  sourceMtimeMs: z.number(),
  keys: z.partialRecord(z.enum(INGEST_STAGES), z.string()),
});
type Manifest = z.infer<typeof ManifestSchema>;

export const pendingIngest = (): Ingest => ({
  status: 'pending',
  stages: INGEST_STAGES.map((name) => ({ name, status: 'pending' })),
});

const cacheKey = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function hashFile(path: string, size: number, onProgress: (p: number) => void): Promise<string> {
  const hash = createHash('sha256');
  let read = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
    hash.update(chunk as Buffer);
    read += (chunk as Buffer).length;
    onProgress(size ? read / size : 1);
  }
  return hash.digest('hex');
}

async function writeJsonAtomic(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

/**
 * Stage 1 of the pipeline: hash, probe, proxy, audio, cuts and shot thumbnails.
 * Each step is skipped when its inputs are unchanged and its outputs exist.
 */
export async function runIngest(
  store: ProjectStore,
  id: string,
  onUpdate: (ingest: Ingest) => void,
): Promise<Ingest> {
  const dir = store.dir(id);
  const manifestPath = join(dir, 'ingest.json');
  const previous = await readFile(manifestPath, 'utf8')
    .then((text) => ManifestSchema.parse(JSON.parse(text)))
    .catch(() => undefined);

  let project = await store.read(id);
  const sourcePath = join(dir, project.source.file);
  const proxyPath = join(dir, project.source.proxy);
  const ingest: Ingest = { status: 'running', stages: pendingIngest().stages };
  const stageOf = (name: StageName) => ingest.stages.find((s) => s.name === name)!;

  const save = async () => {
    project = await store.update(id, (p) => {
      p.ingest = structuredClone(ingest);
    });
  };
  await save();
  onUpdate(ingest);

  const sourceStat = await stat(sourcePath);
  const manifest: Manifest = {
    sourceHash: previous?.sourceHash ?? '',
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    keys: { ...previous?.keys },
  };

  /** Runs one step unless its key matches the last run and its outputs exist. */
  const step = async (
    name: StageName,
    key: string,
    outputsExist: () => Promise<boolean>,
    work: (progress: (p: number) => void) => Promise<void>,
  ) => {
    const stage: Stage = stageOf(name);
    if (manifest.keys[name] === key && (await outputsExist())) {
      stage.status = 'cached';
      onUpdate(ingest);
      return;
    }
    stage.status = 'running';
    stage.progress = 0;
    await save();
    onUpdate(ingest);
    const started = performance.now();
    await work((p) => {
      stage.progress = p;
      onUpdate(ingest);
    });
    stage.status = 'done';
    delete stage.progress;
    stage.durationMs = Math.round(performance.now() - started);
    manifest.keys[name] = key;
    await writeJsonAtomic(manifestPath, manifest);
    await save();
    onUpdate(ingest);
  };

  try {
    // Re-hash only when the file on disk changed; hashing is the cost of a re-run.
    const unchanged =
      previous?.sourceSize === sourceStat.size && previous.sourceMtimeMs === sourceStat.mtimeMs;
    const hashKey = cacheKey('hash', sourceStat.size, sourceStat.mtimeMs);
    await step(
      'hash',
      hashKey,
      async () => unchanged,
      async (progress) => {
        manifest.sourceHash = await hashFile(sourcePath, sourceStat.size, progress);
      },
    );
    const sourceHash = manifest.sourceHash;

    const probeKey = cacheKey('probe', STEP_VERSION.probe, sourceHash);
    await step(
      'probe',
      probeKey,
      async () => true,
      async () => {
        const result = await probe(sourcePath);
        project = await store.update(id, (p) => {
          p.source = { ...p.source, ...result };
        });
      },
    );
    const { fps, durationSec, hasAudio } = project.source;

    const proxyKey = cacheKey('proxy', STEP_VERSION.proxy, sourceHash, fps, PROXY);
    await step(
      'proxy',
      proxyKey,
      () => exists(proxyPath),
      async (progress) => {
        const tmp = join(dir, 'proxy.tmp.mp4');
        const gop = String(Math.max(1, Math.round(fps)));
        await ffmpeg(
          [
            '-i', sourcePath,
            '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', `scale=-2:'trunc(min(${PROXY.maxHeight},ih)/2)*2',format=yuv420p`,
            // Same frame rate as the source, constant, so frame n of the proxy is frame n of the source.
            '-fps_mode', 'cfr', '-r', String(fps),
            '-c:v', 'libx264', '-preset', PROXY.preset, '-crf', String(PROXY.crf),
            // A keyframe every second keeps scrubbing smooth.
            '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
            '-c:a', 'aac', '-b:a', `${PROXY.audioKbps}k`, '-ac', '2', '-ar', '48000',
            '-movflags', '+faststart',
            tmp,
          ],
          durationSec,
          progress,
        );
        await rename(tmp, proxyPath);
      },
    );

    const audioPath = join(dir, 'audio.wav');
    if (hasAudio) {
      await step(
        'audio',
        cacheKey('audio', STEP_VERSION.audio, sourceHash),
        () => exists(audioPath),
        async (progress) => {
          const tmp = join(dir, 'audio.tmp.wav');
          // Mono 16 kHz is what speech-to-text APIs expect.
          await ffmpeg(
            ['-i', sourcePath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp],
            durationSec,
            progress,
          );
          await rename(tmp, audioPath);
        },
      );
    } else {
      await rm(audioPath, { force: true });
      stageOf('audio').status = 'skipped';
      onUpdate(ingest);
    }

    const shotsKey = cacheKey('shots', STEP_VERSION.shots, proxyKey, CUT_DETECTION);
    await step(
      'shots',
      shotsKey,
      async () => project.shots !== undefined,
      async (progress) => {
        const output = await ffmpeg(
          [
            '-i', proxyPath,
            '-an',
            '-vf', `scale=${CUT_DETECTION.scaleWidth}:-2,scdet=threshold=100,metadata=print:file=-`,
            '-f', 'null', '-',
          ],
          durationSec,
          progress,
        );
        const shots = shotsFromCuts(detectCuts(parseScdet(output)), durationSec);
        project = await store.update(id, (p) => {
          p.shots = shots;
        });
      },
    );

    const shots = project.shots ?? [];
    const thumbFiles = shots.map((_, i) => join(dir, shotThumbnailFile(i)));
    await step(
      'thumbnails',
      cacheKey('thumbnails', STEP_VERSION.thumbnails, proxyKey, shots, THUMB_WIDTH),
      async () => (await Promise.all(thumbFiles.map(exists))).every(Boolean),
      async (progress) => {
        const tmpDir = join(dir, 'frames.tmp');
        await rm(tmpDir, { recursive: true, force: true });
        await mkdir(tmpDir);
        let done = 0;
        let next = 0;
        const worker = async () => {
          while (next < shots.length) {
            const i = next++;
            const shot = shots[i]!;
            // The middle of the shot is more representative than its first frame.
            const mid = (shot.start + shot.end) / 2;
            await ffmpeg(
              [
                '-ss', mid.toFixed(3), '-i', proxyPath,
                '-frames:v', '1', '-an', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '4',
                join(tmpDir, shotThumbnailFile(i).replace('frames/', '')),
              ],
              0,
            );
            progress(++done / shots.length);
          }
        };
        await Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker));
        await rm(join(dir, 'frames'), { recursive: true, force: true });
        await rename(tmpDir, join(dir, 'frames'));
      },
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
