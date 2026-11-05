import { ProjectSchema, RenderJobSchema, UploadRecordSchema, type HistoryEntry, type Project, type RenderJob, type UploadRecord } from '@als/schema';
// The ports move here from apps/server when the Node server is retired (end of C3).
import { NotFoundError, VersionConflictError, type ProjectRepo, type StageEntry, type StageKind } from '../../../server/src/ports.ts';
import { PG, pgCode, type Db, type Sql } from './db.ts';

/** Saved versions kept per project, as on Node (`HISTORY_LIMIT` in fs-repo). */
export const HISTORY_LIMIT = 20;

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The same readable ids as on Node: a slug of the name plus 4 hex digits. */
export function slugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\.[^.]*$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'clip'
  );
}

interface ProjectRow {
  doc: unknown;
  version: number;
}

/**
 * Projects in Postgres (`app` schema, see supabase/migrations). Every call runs
 * in the current scope (`scopes` in db.ts): a user sees and changes only their
 * own projects, by RLS; the service sees all.
 */
export class PgProjectRepo implements ProjectRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async newId(name: string): Promise<string> {
    const slug = slugFor(name);
    for (;;) {
      const id = `${slug}-${hex(2)}`;
      const reserved = await this.db.tx((sql) =>
        sql.query('insert into app.project_ids (id, owner_id) values ($1, auth.uid()) on conflict (id) do nothing returning id', [id]),
      );
      if (reserved.rowCount) return id;
    }
  }

  async list(): Promise<Project[]> {
    const { rows } = await this.db.tx((sql) => sql.query<{ doc: unknown }>(`select doc from app.projects order by doc->>'createdAt' desc`));
    // As on Node, a document that no longer parses is left out rather than failing the list.
    return rows.flatMap((r) => {
      const parsed = ProjectSchema.safeParse(r.doc);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async read(id: string): Promise<Project> {
    const { rows } = await this.db.tx((sql) => sql.query<{ doc: unknown }>('select doc from app.projects where id = $1', [id]));
    if (!rows[0]) throw new NotFoundError(`project ${id} not found`);
    return ProjectSchema.parse(rows[0].doc);
  }

  async create(project: Project): Promise<Project> {
    const doc = ProjectSchema.parse(project);
    try {
      await this.db.tx(async (sql) => {
        // Reserved by newId already, except for projects made another way (seeding, migration).
        await sql.query('insert into app.project_ids (id, owner_id) values ($1, auth.uid()) on conflict (id) do nothing', [doc.id]);
        await sql.query(
          `insert into app.projects (id, version, created_at, doc) values ($1, $2, $3, $4)
           on conflict (id) do update set version = excluded.version, doc = excluded.doc, updated_at = now()`,
          [doc.id, doc.version, doc.createdAt, JSON.stringify(doc)],
        );
      });
    } catch (error) {
      // Someone else's id: RLS refuses the row, and to this user the id doesn't exist.
      if (pgCode(error) === PG.rlsViolation) throw new NotFoundError(`project ${doc.id} not found`);
      throw error;
    }
    return doc;
  }

  update(id: string, change: (project: Project) => Project | void, options: { snapshot?: boolean } = {}): Promise<Project> {
    return this.db.tx(async (sql) => {
      const current = await this.lockedRow(sql, id);
      const next = applyChange(current, change);
      await this.write(sql, id, next, options.snapshot ?? false);
      return next;
    });
  }

  save(id: string, baseVersion: number, change: (project: Project) => Project | void): Promise<Project> {
    return this.db.tx(async (sql) => {
      const current = await this.lockedRow(sql, id);
      if (current.version !== baseVersion) throw new VersionConflictError(current.version);
      const next = applyChange(current, change);
      await this.write(sql, id, next, true);
      return next;
    });
  }

  async history(id: string): Promise<HistoryEntry[]> {
    const { rows } = await this.db.tx(async (sql) => {
      // A project the caller can't see is not found, not an empty history.
      const project = await sql.query('select 1 from app.projects where id = $1', [id]);
      if (!project.rowCount) throw new NotFoundError(`project ${id} not found`);
      return sql.query<{ version: number; saved_at: Date; moment_count: number }>(
        `select version, saved_at, coalesce(jsonb_array_length(doc->'moments'), 0) as moment_count
         from app.project_versions where project_id = $1 order by version desc`,
        [id],
      );
    });
    return rows.map((r) => ({ version: r.version, savedAt: r.saved_at.toISOString(), momentCount: r.moment_count }));
  }

  async readVersion(id: string, version: number): Promise<Project> {
    const { rows } = await this.db.tx((sql) =>
      sql.query<{ doc: unknown }>('select doc from app.project_versions where project_id = $1 and version = $2', [id, version]),
    );
    if (!rows[0]) throw new NotFoundError(`version ${version} of ${id} not found`);
    return ProjectSchema.parse(rows[0].doc);
  }

  /** Deletes the project and every row hanging off it. Its files are the BlobStore's (the route deletes both). */
  async remove(id: string): Promise<void> {
    await this.db.tx((sql) => sql.query('delete from app.project_ids where id = $1', [id]));
  }

  async getStage(projectId: string, kind: StageKind, stage: string): Promise<StageEntry | undefined> {
    const { rows } = await this.db.tx((sql) =>
      sql.query<{ key: string; output: unknown }>('select key, output from app.stage_cache where project_id = $1 and kind = $2 and stage = $3', [
        projectId,
        kind,
        stage,
      ]),
    );
    return rows[0] ? { key: rows[0].key, output: rows[0].output } : undefined;
  }

  async putStage(projectId: string, kind: StageKind, stage: string, key: string, output: unknown): Promise<void> {
    await this.db.tx((sql) =>
      sql.query(
        `insert into app.stage_cache (project_id, kind, stage, key, output) values ($1, $2, $3, $4, $5)
         on conflict (project_id, kind, stage) do update set key = excluded.key, output = excluded.output, updated_at = now()`,
        [projectId, kind, stage, key, output === undefined ? null : JSON.stringify(output)],
      ),
    );
  }

  async renders(projectId: string): Promise<RenderJob[]> {
    return this.db.tx(async (sql) => {
      const project = await sql.query('select 1 from app.projects where id = $1', [projectId]);
      if (!project.rowCount) throw new NotFoundError(`project ${projectId} not found`);
      return this.renderRows(sql, projectId);
    });
  }

  editRenders(projectId: string, change: (jobs: RenderJob[]) => void | Promise<void>): Promise<void> {
    return this.db.tx(async (sql) => {
      // One edit of a project's list at a time, even while the list is empty.
      const owner = await sql.query('select 1 from app.project_ids where id = $1 for update', [projectId]);
      if (!owner.rowCount) throw new NotFoundError(`project ${projectId} not found`);
      const jobs = await this.renderRows(sql, projectId);
      await change(jobs);
      const next = RenderJobSchema.array().parse(jobs);
      await sql.query('delete from app.renders where project_id = $1 and not (id = any($2::text[]))', [projectId, next.map((j) => j.id)]);
      for (const [i, job] of next.entries()) {
        await sql.query(
          `insert into app.renders (project_id, id, position, version, status, job) values ($1, $2, $3, $4, $5, $6)
           on conflict (project_id, id) do update set position = excluded.position, version = excluded.version,
             status = excluded.status, job = excluded.job, updated_at = now()`,
          [projectId, job.id, i, job.projectVersion, job.status, JSON.stringify(job)],
        );
      }
    });
  }

  async getUpload(projectId: string): Promise<UploadRecord | undefined> {
    const { rows } = await this.db.tx((sql) => sql.query<{ record: unknown }>('select record from app.uploads where project_id = $1', [projectId]));
    return rows[0] ? UploadRecordSchema.parse(rows[0].record) : undefined;
  }

  async putUpload(upload: UploadRecord): Promise<void> {
    const record = UploadRecordSchema.parse(upload);
    try {
      await this.db.tx((sql) =>
        sql.query(
          `insert into app.uploads (project_id, record) values ($1, $2)
           on conflict (project_id) do update set record = excluded.record`,
          [record.projectId, JSON.stringify(record)],
        ),
      );
    } catch (error) {
      if (pgCode(error) === PG.rlsViolation) throw new NotFoundError(`project ${record.projectId} not found`);
      throw error;
    }
  }

  async removeUpload(projectId: string): Promise<void> {
    await this.db.tx((sql) => sql.query('delete from app.uploads where project_id = $1', [projectId]));
  }

  private async renderRows(sql: Sql, projectId: string): Promise<RenderJob[]> {
    const { rows } = await sql.query<{ job: unknown }>('select job from app.renders where project_id = $1 order by position, created_at, id', [projectId]);
    return RenderJobSchema.array().parse(rows.map((r) => r.job));
  }

  /** The project, locked until the transaction ends so concurrent changes apply one after another. */
  private async lockedRow(sql: Sql, id: string): Promise<Project> {
    const { rows } = await sql.query<ProjectRow>('select doc, version from app.projects where id = $1 for update', [id]);
    if (!rows[0]) throw new NotFoundError(`project ${id} not found`);
    return ProjectSchema.parse(rows[0].doc);
  }

  /**
   * Writes the next version in one statement: with `snapshot`, the current row
   * goes into history first and history is trimmed to the newest HISTORY_LIMIT
   * (every part of the statement sees the row as it was before the update).
   */
  private async write(sql: Sql, id: string, next: Project, snapshot: boolean): Promise<void> {
    const doc = JSON.stringify(next);
    if (!snapshot) {
      await sql.query('update app.projects set version = $2, doc = $3, updated_at = now() where id = $1', [id, next.version, doc]);
      return;
    }
    await sql.query(
      `with snap as (
         insert into app.project_versions (project_id, version, saved_at, doc)
         select id, version, updated_at, doc from app.projects where id = $1
         on conflict (project_id, version) do update set saved_at = excluded.saved_at, doc = excluded.doc
       ),
       trimmed as (
         delete from app.project_versions
         where project_id = $1 and version < (
           select min(version) from (
             select version from app.project_versions where project_id = $1 order by version desc limit ${HISTORY_LIMIT - 1}
           ) kept
         )
       )
       update app.projects set version = $2, doc = $3, updated_at = now() where id = $1`,
      [id, next.version, doc],
    );
  }
}

function applyChange(current: Project, change: (project: Project) => Project | void): Project {
  const draft = structuredClone(current);
  return ProjectSchema.parse({ ...(change(draft) ?? draft), version: current.version + 1 });
}
