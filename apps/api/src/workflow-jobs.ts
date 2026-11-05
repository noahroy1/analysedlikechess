import { AsyncLocalStorage } from 'node:async_hooks';
import { JobSchema, type Job, type JobKind, type JobState } from '@als/schema';
import type { EventBus, JobHandler, JobRunner, StartJob } from '../../server/src/ports.ts';
import { asService, type Db } from './db/db.ts';

/** What a job's Workflow instance is started with (event.payload). */
export interface JobParams {
  jobId: string;
  kind: JobKind;
  projectId: string;
  userId: string;
  request?: unknown;
}

/** The parts of the Workflow binding this uses. */
export interface JobsBinding {
  create(options: { id: string; params: JobParams }): Promise<unknown>;
  get(id: string): Promise<{ restart(options?: { from?: { name: string } }): Promise<void> }>;
}

/** The parts of a Workflow step this uses. */
export interface StepRunner {
  do<T>(name: string, config: StepConfig, work: () => Promise<T>): Promise<T>;
}

interface StepConfig {
  retries: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' };
  timeout: string | number;
}

/**
 * Every job step's config. A step is one stage (a paid call, an ffmpeg pass,
 * one render chunk): an OpenAI flex call can take 13 minutes (Oct 13), so the
 * timeout is the 30 minutes Workflows advise as the most. A failed step retries
 * once, not the default five times, since a retry of a paid call pays again.
 */
export const JOB_STEP: StepConfig = { retries: { limit: 1, delay: '10 seconds', backoff: 'constant' }, timeout: '30 minutes' };

/** Live jobs are these; the rest are history. */
const LIVE = `status in ('pending', 'running')`;
/** Progress is broadcast at most this often per job; status changes always go out. */
const BROADCAST_MS = 150;
/** The live state is saved at most this often (what GET /jobs and a reconnecting client read). */
const SAVE_MS = 1_000;
/** How often a running job looks for a cancel. */
const CANCEL_POLL_MS = 2_000;

interface JobRow {
  id: string;
  project_id: string;
  kind: JobKind;
  state: unknown;
}

const toJob = (row: JobRow): Job => JobSchema.parse({ id: row.id, projectId: row.project_id, kind: row.kind, state: row.state });

/** A status change of the job or any of its stages: always sent at once. */
function signature(job: Job): string {
  if (job.kind === 'render') return `${job.state.status}:${job.state.stage ?? ''}`;
  return job.state.status + job.state.stages.map((s) => s.status).join();
}

/**
 * Jobs as Cloudflare Workflows (PLAN-CLOUD.md, Architecture): a row in
 * `app.jobs` (one live job per project and kind, by a unique index) and a
 * Workflow instance named by the job's id. The instance runs the registered
 * handler; each `step()` is a Workflow step, so a job resumes after a restart
 * or deploy without redoing finished stages. Reads and writes run in the
 * current scope: a user sees only their own jobs.
 */
export class WorkflowJobRunner implements JobRunner {
  private readonly db: Db;
  private readonly events: EventBus;
  private readonly binding: JobsBinding;
  private readonly handlers = new Map<JobKind, JobHandler<JobKind>>();

  constructor(options: { db: Db; events: EventBus; binding: JobsBinding }) {
    this.db = options.db;
    this.events = options.events;
    this.binding = options.binding;
  }

  register<K extends JobKind>(kind: K, handler: JobHandler<K>): void {
    this.handlers.set(kind, handler as unknown as JobHandler<JobKind>);
  }

  async start<K extends JobKind>(kind: K, projectId: string, start: StartJob<K>): Promise<{ job: Extract<Job, { kind: K }>; created: boolean }> {
    const id = crypto.randomUUID();
    const inserted = await this.db.tx((sql) =>
      sql.query<JobRow>(
        `insert into app.jobs (id, project_id, owner_id, kind, status, request, state) values ($1, $2, $3, $4, 'pending', $5, $6)
         on conflict (project_id, kind) where ${LIVE} do nothing
         returning id, project_id, kind, state`,
        [id, projectId, start.userId, kind, start.request === undefined ? null : JSON.stringify(start.request), JSON.stringify(start.state)],
      ),
    );
    if (!inserted.rows[0]) {
      const existing = await this.find(kind, projectId);
      if (existing) return { job: existing, created: false };
      // It finished between the insert and the read: try again.
      return this.start(kind, projectId, start);
    }
    const job = toJob(inserted.rows[0]) as Extract<Job, { kind: K }>;
    const params: JobParams = { jobId: id, kind, projectId, userId: start.userId, ...(start.request === undefined ? {} : { request: start.request }) };
    try {
      await this.binding.create({ id, params });
    } catch (error) {
      await this.finish(id, 'failed');
      throw error;
    }
    this.events.publish(start.userId, job);
    return { job, created: true };
  }

  async find<K extends JobKind>(kind: K, projectId: string): Promise<Extract<Job, { kind: K }> | undefined> {
    const { rows } = await this.db.tx((sql) =>
      sql.query<JobRow>(`select id, project_id, kind, state from app.jobs where project_id = $1 and kind = $2 and ${LIVE}`, [projectId, kind]),
    );
    return rows[0] ? (toJob(rows[0]) as Extract<Job, { kind: K }>) : undefined;
  }

  async list(userId: string): Promise<Job[]> {
    const { rows } = await this.db.tx((sql) =>
      sql.query<JobRow>(`select id, project_id, kind, state from app.jobs where owner_id = $1 and ${LIVE} order by created_at`, [userId]),
    );
    return rows.map(toJob);
  }

  /** Marks the job cancelled; its instance sees that within CANCEL_POLL_MS and aborts its handler, which cleans up. */
  async cancel(jobId: string): Promise<boolean> {
    const { rowCount } = await this.db.tx((sql) => sql.query(`update app.jobs set status = 'cancelled', updated_at = now() where id = $1 and ${LIVE}`, [jobId]));
    return Boolean(rowCount);
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const { rows } = await asService(() => this.db.tx((sql) => sql.query<{ n: number }>(`select count(*)::int as n from app.jobs where ${LIVE}`)));
      if (!rows[0]?.n) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /**
   * The Workflow's body: runs the job's handler with its steps as Workflow
   * steps. Runs again from the top when an instance resumes; finished steps
   * return their stored results, and the stages' caches skip finished work.
   */
  execute(params: JobParams, step: StepRunner): Promise<void> {
    return asService(async () => {
      const { jobId, kind, userId } = params;
      const handler = this.handlers.get(kind);
      if (!handler) throw new Error(`no handler for ${kind} jobs`);

      const started = await this.db.tx((sql) =>
        sql.query<JobRow>(`update app.jobs set status = 'running', updated_at = now() where id = $1 and ${LIVE} returning id, project_id, kind, state`, [jobId]),
      );
      // Cancelled (or finished) before it ran.
      if (!started.rows[0]) return;
      let job = toJob(started.rows[0]);

      const inContext = AsyncLocalStorage.snapshot();
      const controller = new AbortController();
      const watch = setInterval(() => {
        void this.db
          .tx((sql) => sql.query<{ status: string }>('select status from app.jobs where id = $1', [jobId]))
          .then(({ rows }) => {
            if (rows[0]?.status === 'cancelled') controller.abort(new Error('cancelled'));
          })
          .catch(() => undefined);
      }, CANCEL_POLL_MS);

      let lastSent: { at: number; signature: string } | undefined;
      let lastSaved = 0;
      let saving: Promise<unknown> = Promise.resolve();
      const save = (force: boolean) => {
        const now = Date.now();
        if (!force && now - lastSaved < SAVE_MS) return;
        lastSaved = now;
        const state = JSON.stringify(job.state);
        saving = saving
          .catch(() => undefined)
          .then(() => this.db.tx((sql) => sql.query(`update app.jobs set state = $2, updated_at = now() where id = $1 and ${LIVE}`, [jobId, state])));
      };
      const report = (state: JobState<JobKind>) => {
        job = { ...job, state: structuredClone(state) } as Job;
        const sig = signature(job);
        const now = Date.now();
        const urgent = lastSent?.signature !== sig;
        save(urgent);
        if (!urgent && lastSent && now - lastSent.at < BROADCAST_MS) return;
        lastSent = { at: now, signature: sig };
        this.events.publish(userId, structuredClone(job));
      };

      let outcome: 'done' | 'failed' = 'done';
      try {
        await handler({
          job: structuredClone(job) as never,
          userId,
          request: params.request,
          signal: controller.signal,
          report,
          // A step's callback runs outside this context (the service scope, the keep-alive collector): carry it in.
          step: async (name, work) => {
            await this.db.tx((sql) => sql.query('update app.jobs set step = $2 where id = $1', [jobId, name]));
            return step.do(name, JOB_STEP, () => inContext(work));
          },
        });
      } catch (error) {
        // Handlers record their own failures in project state; this is e.g. a project deleted mid-run.
        console.error(`${kind} job ${jobId} for ${params.projectId} failed:`, error);
        outcome = 'failed';
      } finally {
        clearInterval(watch);
        await saving.catch(() => undefined);
      }
      await this.db.tx((sql) => sql.query(`update app.jobs set state = $2, updated_at = now() where id = $1`, [jobId, JSON.stringify(job.state)]));
      await this.finish(jobId, outcome);
      this.events.publish(userId, job);
    });
  }

  /**
   * Dev only: local Workflows don't pick up a step that was running when
   * `wrangler dev` was killed (Cloudflare's engine retries it on its own). A
   * fresh dev session restarts each job still marked running from the step it
   * was in; the steps before it return their stored results.
   */
  resumeOrphans(): Promise<string[]> {
    return asService(async () => {
      const { rows } = await this.db.tx((sql) => sql.query<{ id: string; step: string | null }>(`select id, step from app.jobs where status = 'running'`));
      const resumed: string[] = [];
      for (const { id, step } of rows) {
        try {
          const instance = await this.binding.get(id);
          await instance.restart(step ? { from: { name: step } } : undefined);
          resumed.push(id);
        } catch (error) {
          console.warn(`job ${id} not resumed:`, error);
        }
      }
      return resumed;
    });
  }

  private async finish(jobId: string, status: 'done' | 'failed') {
    // A cancelled job stays cancelled.
    await this.db.tx((sql) => sql.query(`update app.jobs set status = $2, updated_at = now() where id = $1 and ${LIVE}`, [jobId, status]));
  }
}
