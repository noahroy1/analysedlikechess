import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/db.ts';
import { HINTS_STAGE, projectKey, type BlobStore, type ProjectRepo, type StageKind } from '../ports.ts';
import { FsProjectRepo } from './fs-repo.ts';

// C4's migration (PLAN-CLOUD.md): a project folder of the Node server into
// Postgres and R2, under one owner. The folder is only read. A second run
// writes everything again except files already in R2 at the same size, so an
// interrupted run can be repeated.

/**
 * Files FsProjectRepo keeps itself (they become rows); every other file in a
 * project folder is media or a stage output the app reads through the
 * BlobStore, and goes to R2 under the same key.
 */
const REPO_FILES = [/^project\.json$/, /^history\//, /^ingest\.json$/, /^analysis\/manifest\.json$/, /^analysis\/regions-cache\.json$/, /^renders\/renders\.json$/, /^upload\.json$/];

const Keys = z.object({ keys: z.record(z.string(), z.string()) });

/**
 * The default part size (MigrateTarget.partBytes): a deployed target's bucket is
 * reached through a Worker, and one request to a Worker carries at most 100 MB
 * (a 120 MB write hung, Nov 6).
 */
export const MIGRATE_PART_BYTES = 32 * 1024 * 1024;

async function putInParts(blobs: BlobStore, key: string, file: string, size: number, partBytes: number): Promise<void> {
  const uploadId = await blobs.createMultipart(key);
  const handle = await open(file);
  try {
    const parts = [];
    for (let offset = 0, partNumber = 1; offset < size; offset += partBytes, partNumber++) {
      const chunk = new Uint8Array(Math.min(partBytes, size - offset));
      await handle.read(chunk, 0, chunk.length, offset);
      const etag = await blobs.uploadPart(key, uploadId, partNumber, new Response(chunk).body!);
      parts.push({ partNumber, etag });
    }
    await blobs.completeMultipart(key, uploadId, parts);
  } catch (error) {
    await blobs.abortMultipart(key, uploadId).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

export interface MigrateTarget {
  /** Run as the owner (`asUser`), so RLS checks every write. */
  repo: ProjectRepo;
  db: Db;
  blobs: BlobStore;
  /** Files over twice this go up as a multipart upload in parts of this size (MIGRATE_PART_BYTES when absent). */
  partBytes?: number;
}

export interface MigrateReport {
  id: string;
  versions: number;
  stages: number;
  renders: number;
  files: number;
  skippedFiles: number;
  bytes: number;
}

async function readJson(file: string): Promise<unknown> {
  return readFile(file, 'utf8').then((t) => JSON.parse(t) as unknown, () => undefined);
}

/** Every file under `dir`, as paths relative to it with `/`, skipping dot-files and render chunk folders. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .filter((rel) => !rel.split('/').some((part) => part.startsWith('.') || part.endsWith('.parts')))
    .sort();
}

/** The stage names a folder has outputs for, per kind. */
async function stageNames(dir: string): Promise<[StageKind, string][]> {
  const ingest = Keys.safeParse(await readJson(join(dir, 'ingest.json')));
  const analysis = Keys.safeParse(await readJson(join(dir, 'analysis/manifest.json')));
  const regions = z.record(z.string(), z.unknown()).safeParse(await readJson(join(dir, 'analysis/regions-cache.json')));
  return [
    ...(ingest.success ? Object.keys(ingest.data.keys).map((s) => ['ingest', s] as [StageKind, string]) : []),
    ...(analysis.success ? [...Object.keys(analysis.data.keys), HINTS_STAGE].map((s) => ['analysis', s] as [StageKind, string]) : []),
    ...(regions.success ? Object.keys(regions.data).map((s) => ['regions', s] as [StageKind, string]) : []),
  ];
}

/**
 * Copies one project: the document, its history (with the versions it had),
 * the stage caches, the render list and every media file. Call it as the owner.
 */
export async function migrateProject(source: FsProjectRepo, id: string, to: MigrateTarget, log: (line: string) => void = () => undefined): Promise<MigrateReport> {
  const dir = source.dir(id);
  const project = await source.read(id);
  await to.repo.create(project);

  const history = await source.history(id);
  for (const entry of history) {
    const doc = await source.readVersion(id, entry.version);
    await to.db.tx((sql) =>
      sql.query(
        `insert into app.project_versions (project_id, version, saved_at, doc) values ($1, $2, $3, $4)
         on conflict (project_id, version) do update set saved_at = excluded.saved_at, doc = excluded.doc`,
        [id, entry.version, entry.savedAt, JSON.stringify(doc)],
      ),
    );
  }

  let stages = 0;
  for (const [kind, stage] of await stageNames(dir)) {
    const entry = await source.getStage(id, kind, stage);
    if (!entry) continue;
    await to.repo.putStage(id, kind, stage, entry.key, entry.output);
    stages++;
  }

  const renders = await source.renders(id);
  await to.repo.editRenders(id, (jobs) => {
    jobs.splice(0, jobs.length, ...renders);
  });

  // Analysis outputs are rows now (stage_cache), not files.
  const stageFiles = new Set((await stageNames(dir)).filter(([kind]) => kind === 'analysis').map(([, stage]) => `analysis/${stage}.json`));
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  for (const rel of await files(dir)) {
    if (stageFiles.has(rel) || REPO_FILES.some((pattern) => pattern.test(rel))) continue;
    const key = projectKey(id, rel);
    const size = (await stat(join(dir, rel))).size;
    if ((await to.blobs.head(key))?.size === size) {
      skipped++;
      continue;
    }
    const partBytes = to.partBytes ?? MIGRATE_PART_BYTES;
    if (size > 2 * partBytes) await putInParts(to.blobs, key, join(dir, rel), size, partBytes);
    else await to.blobs.put(key, new Uint8Array(await readFile(join(dir, rel))));
    copied++;
    bytes += size;
    if (size > 8 * 1024 * 1024) log(`  ${rel} (${Math.round(size / 1024 / 1024)} MB)`);
  }
  return { id, versions: history.length, stages, renders: renders.length, files: copied, skippedFiles: skipped, bytes };
}
