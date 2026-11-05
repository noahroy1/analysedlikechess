import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ProjectSchema, RenderJobSchema, UploadRecordSchema, type HistoryEntry, type Project, type RenderJob, type UploadRecord } from '@als/schema';
import { HINTS_STAGE, NotFoundError, VersionConflictError, type ProjectRepo, type StageEntry, type StageKind } from '../ports.ts';

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const HISTORY_FILE = /^v(\d{6})\.json$/;

/** Saved versions kept per project, so a bad edit or AI run is recoverable. */
export const HISTORY_LIMIT = 20;

/** `analysis/manifest.json`: each stage's key, plus the perception hints captured on the first run. */
const AnalysisManifestSchema = z.object({
  keys: z.record(z.string(), z.string()),
  perceptionHints: z.array(z.string()).optional(),
});
/** `ingest.json`: each step's key and the source's hash. */
const IngestManifestSchema = z.looseObject({
  sourceHash: z.string(),
  keys: z.record(z.string(), z.string()),
});
const RegionsCacheSchema = z.record(z.string(), z.unknown());


/**
 * Projects as folders under one root: `<root>/<id>/project.json`, `history/`,
 * `ingest.json`, `analysis/` and `renders/renders.json`, with the media beside them.
 * The layout is the one the app has always written, so existing projects open unchanged.
 */
export class FsProjectRepo implements ProjectRepo {
  /** Per-file write chains, so concurrent updates apply one after another. */
  private readonly locks = new Map<string, Promise<unknown>>();

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dir(id: string): string {
    if (!PROJECT_ID.test(id)) throw new NotFoundError(`project ${id} not found`);
    return join(this.root, id);
  }

  private file(id: string, name: string): string {
    return join(this.dir(id), name);
  }

  async newId(name: string): Promise<string> {
    const slug =
      name
        .toLowerCase()
        .replace(/\.[^.]*$/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'clip';
    await mkdir(this.root, { recursive: true });
    for (;;) {
      const id = `${slug}-${randomBytes(2).toString('hex')}`;
      try {
        await mkdir(this.dir(id));
        return id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }

  async list(): Promise<Project[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const projects = await Promise.all(
      entries.filter((e) => e.isDirectory() && PROJECT_ID.test(e.name)).map((e) => this.read(e.name).catch(() => undefined)),
    );
    return projects.filter((p): p is Project => p !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async read(id: string): Promise<Project> {
    const text = await readFile(this.file(id, 'project.json'), 'utf8').catch(() => {
      throw new NotFoundError(`project ${id} not found`);
    });
    return ProjectSchema.parse(JSON.parse(text));
  }

  create(project: Project): Promise<Project> {
    return this.locked(project.id, async () => {
      await mkdir(this.dir(project.id), { recursive: true });
      return this.write(ProjectSchema.parse(project));
    });
  }

  update(id: string, change: (project: Project) => Project | void, options: { snapshot?: boolean } = {}): Promise<Project> {
    return this.locked(id, async () => {
      const current = await this.read(id);
      const draft = structuredClone(current);
      const next = ProjectSchema.parse({ ...(change(draft) ?? draft), version: current.version + 1 });
      if (options.snapshot) await this.snapshot(current);
      return this.write(next);
    });
  }

  save(id: string, baseVersion: number, change: (project: Project) => Project | void): Promise<Project> {
    return this.locked(id, async () => {
      const current = await this.read(id);
      if (current.version !== baseVersion) throw new VersionConflictError(current.version);
      const draft = structuredClone(current);
      const next = ProjectSchema.parse({ ...(change(draft) ?? draft), version: current.version + 1 });
      await this.snapshot(current);
      return this.write(next);
    });
  }

  async history(id: string): Promise<HistoryEntry[]> {
    await this.read(id);
    const dir = this.file(id, 'history');
    const files = await readdir(dir).catch(() => [] as string[]);
    const entries = await Promise.all(
      files
        .filter((f) => HISTORY_FILE.test(f))
        .map(async (f) => {
          const project = ProjectSchema.parse(JSON.parse(await readFile(join(dir, f), 'utf8')));
          return { version: project.version, savedAt: (await stat(join(dir, f))).mtime.toISOString(), momentCount: project.moments.length };
        }),
    );
    return entries.sort((a, b) => b.version - a.version);
  }

  async readVersion(id: string, version: number): Promise<Project> {
    const text = await readFile(this.file(id, `history/${historyFile(version)}`), 'utf8').catch(() => {
      throw new NotFoundError(`version ${version} of ${id} not found`);
    });
    return ProjectSchema.parse(JSON.parse(text));
  }

  async remove(id: string): Promise<void> {
    await this.locked(id, () => rm(this.dir(id), { recursive: true, force: true }));
  }

  async getStage(projectId: string, kind: StageKind, stage: string): Promise<StageEntry | undefined> {
    if (kind === 'regions') {
      const output = (await this.regionsCache(projectId))[stage];
      return output === undefined ? undefined : { key: stage, output };
    }
    if (kind === 'ingest') {
      const manifest = await this.readJson(projectId, 'ingest.json', IngestManifestSchema);
      const key = manifest?.keys[stage];
      if (key === undefined) return undefined;
      return { key, output: stage === 'hash' ? { sourceHash: manifest!.sourceHash } : null };
    }
    const manifest = await this.readJson(projectId, 'analysis/manifest.json', AnalysisManifestSchema);
    if (stage === HINTS_STAGE) return manifest?.perceptionHints ? { key: '', output: manifest.perceptionHints } : undefined;
    const key = manifest?.keys[stage];
    if (key === undefined) return undefined;
    const output = await readFile(this.file(projectId, `analysis/${stage}.json`), 'utf8').then(
      (t) => JSON.parse(t) as unknown,
      () => undefined,
    );
    return output === undefined ? undefined : { key, output };
  }

  putStage(projectId: string, kind: StageKind, stage: string, key: string, output: unknown): Promise<void> {
    return this.locked(`${projectId}:${kind}`, async () => {
      if (kind === 'regions') {
        const cache = await this.regionsCache(projectId);
        cache[stage] = output;
        await this.writeJson(projectId, 'analysis/regions-cache.json', cache, false);
      } else if (kind === 'ingest') {
        const manifest = (await this.readJson(projectId, 'ingest.json', IngestManifestSchema)) ?? { sourceHash: '', keys: {} };
        manifest.keys[stage] = key;
        if (stage === 'hash') manifest.sourceHash = z.object({ sourceHash: z.string() }).parse(output).sourceHash;
        await this.writeJson(projectId, 'ingest.json', manifest);
      } else {
        const manifest = (await this.readJson(projectId, 'analysis/manifest.json', AnalysisManifestSchema)) ?? { keys: {} };
        if (stage === HINTS_STAGE) manifest.perceptionHints = z.array(z.string()).parse(output);
        else {
          // The output first, then the key that says it is current.
          await this.writeJson(projectId, `analysis/${stage}.json`, output);
          manifest.keys[stage] = key;
        }
        await this.writeJson(projectId, 'analysis/manifest.json', manifest);
      }
    });
  }

  async renders(projectId: string): Promise<RenderJob[]> {
    await this.read(projectId);
    return (await this.readJson(projectId, 'renders/renders.json', RenderJobSchema.array())) ?? [];
  }

  editRenders(projectId: string, change: (jobs: RenderJob[]) => void | Promise<void>): Promise<void> {
    return this.locked(`${projectId}:renders`, async () => {
      const jobs = (await this.readJson(projectId, 'renders/renders.json', RenderJobSchema.array())) ?? [];
      await change(jobs);
      await this.writeJson(projectId, 'renders/renders.json', RenderJobSchema.array().parse(jobs));
    });
  }

  getUpload(projectId: string): Promise<UploadRecord | undefined> {
    return this.readJson(projectId, 'upload.json', UploadRecordSchema);
  }

  async putUpload(upload: UploadRecord): Promise<void> {
    await this.writeJson(upload.projectId, 'upload.json', UploadRecordSchema.parse(upload));
  }

  async removeUpload(projectId: string): Promise<void> {
    await rm(this.file(projectId, 'upload.json'), { force: true });
  }

  private async regionsCache(projectId: string): Promise<Record<string, unknown>> {
    return (await this.readJson(projectId, 'analysis/regions-cache.json', RegionsCacheSchema)) ?? {};
  }

  /** A JSON file, or undefined when it is missing. */
  private async readJson<T>(projectId: string, name: string, schema: z.ZodType<T>): Promise<T | undefined> {
    let text: string;
    try {
      text = await readFile(this.file(projectId, name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return schema.parse(JSON.parse(text));
  }

  private async writeJson(projectId: string, name: string, value: unknown, pretty = true) {
    const path = this.file(projectId, name);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
    await rename(tmp, path);
  }

  private async snapshot(project: Project) {
    const dir = this.file(project.id, 'history');
    await mkdir(dir, { recursive: true });
    await copyFile(this.file(project.id, 'project.json'), join(dir, historyFile(project.version)));
    const files = (await readdir(dir)).filter((f) => HISTORY_FILE.test(f)).sort();
    await Promise.all(files.slice(0, Math.max(0, files.length - HISTORY_LIMIT)).map((f) => rm(join(dir, f))));
  }

  private async write(project: Project): Promise<Project> {
    await this.writeJson(project.id, 'project.json', project);
    return project;
  }

  private locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(id) ?? Promise.resolve()).then(task, task);
    const settled = result.catch(() => undefined);
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return result;
  }
}

const historyFile = (version: number) => `v${String(version).padStart(6, '0')}.json`;
