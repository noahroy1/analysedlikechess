import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectSchema, type HistoryEntry, type Project } from '@als/schema';

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const HISTORY_FILE = /^v(\d{6})\.json$/;

/** Saved versions kept on disk per project, so a bad edit or AI run is recoverable. */
export const HISTORY_LIMIT = 20;

export class ProjectNotFoundError extends Error {}

/** A save based on a version that is no longer current. */
export class VersionConflictError extends Error {
  readonly current: number;

  constructor(current: number) {
    super(`project is at version ${current}`);
    this.current = current;
  }
}

/** Reads and writes project folders under one root: `<root>/<id>/project.json` plus media. */
export class ProjectStore {
  /** Per-project write chains, so concurrent updates apply one after another. */
  private readonly locks = new Map<string, Promise<unknown>>();

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dir(id: string): string {
    if (!PROJECT_ID.test(id)) throw new ProjectNotFoundError(id);
    return join(this.root, id);
  }

  file(id: string, name: string): string {
    return join(this.dir(id), name);
  }

  /** Creates an empty folder with a readable, unique id based on `name`. */
  async createDir(name: string): Promise<string> {
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
      entries
        .filter((e) => e.isDirectory() && PROJECT_ID.test(e.name))
        .map((e) => this.read(e.name).catch(() => undefined)),
    );
    return projects
      .filter((p): p is Project => p !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async read(id: string): Promise<Project> {
    let text: string;
    try {
      text = await readFile(this.file(id, 'project.json'), 'utf8');
    } catch {
      throw new ProjectNotFoundError(id);
    }
    return ProjectSchema.parse(JSON.parse(text));
  }

  /** Writes a brand-new project. */
  create(project: Project): Promise<Project> {
    return this.locked(project.id, () => this.write(ProjectSchema.parse(project)));
  }

  /**
   * Read, change, validate and write back with `version` + 1. With `snapshot`,
   * the current version goes into history first (e.g. before an AI run replaces drafts).
   */
  update(id: string, change: (project: Project) => Project | void, options: { snapshot?: boolean } = {}): Promise<Project> {
    return this.locked(id, async () => {
      const current = await this.read(id);
      const draft = structuredClone(current);
      const next = ProjectSchema.parse({ ...(change(draft) ?? draft), version: current.version + 1 });
      if (options.snapshot) await this.snapshot(current);
      return this.write(next);
    });
  }

  /**
   * An editor save: applies `change` only if the project is still at `baseVersion`,
   * after snapshotting the current version into history.
   */
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

  /** Saved versions, newest first. */
  async history(id: string): Promise<HistoryEntry[]> {
    const dir = join(this.dir(id), 'history');
    const files = await readdir(dir).catch(() => [] as string[]);
    const entries = await Promise.all(
      files
        .filter((f) => HISTORY_FILE.test(f))
        .map(async (f) => {
          const project = ProjectSchema.parse(JSON.parse(await readFile(join(dir, f), 'utf8')));
          return {
            version: project.version,
            savedAt: (await stat(join(dir, f))).mtime.toISOString(),
            momentCount: project.moments.length,
          };
        }),
    );
    return entries.sort((a, b) => b.version - a.version);
  }

  async readVersion(id: string, version: number): Promise<Project> {
    const file = join(this.dir(id), 'history', historyFile(version));
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      throw new ProjectNotFoundError(`${id} v${version}`);
    }
    return ProjectSchema.parse(JSON.parse(text));
  }

  private async snapshot(project: Project) {
    const dir = join(this.dir(project.id), 'history');
    await mkdir(dir, { recursive: true });
    await copyFile(this.file(project.id, 'project.json'), join(dir, historyFile(project.version)));
    const files = (await readdir(dir)).filter((f) => HISTORY_FILE.test(f)).sort();
    await Promise.all(files.slice(0, Math.max(0, files.length - HISTORY_LIMIT)).map((f) => rm(join(dir, f))));
  }

  async remove(id: string): Promise<void> {
    await this.locked(id, () => rm(this.dir(id), { recursive: true, force: true }));
  }

  private async write(project: Project): Promise<Project> {
    const path = this.file(project.id, 'project.json');
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(project, null, 2)}\n`);
    await rename(tmp, path);
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
