import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectSchema, type Project } from '@als/schema';

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

export class ProjectNotFoundError extends Error {}

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

  /** Read, change, validate and write back with `version` + 1. */
  update(id: string, change: (project: Project) => Project | void): Promise<Project> {
    return this.locked(id, async () => {
      const current = await this.read(id);
      const draft = structuredClone(current);
      const next = change(draft) ?? draft;
      return this.write(ProjectSchema.parse({ ...next, version: current.version + 1 }));
    });
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
