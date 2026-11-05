import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaTaskEvent, MediaTaskResult, MediaTaskStatus, StartMediaTask } from '@als/schema';
import { showUrl } from './io.ts';
import type { StepContext } from './ingest.ts';
import { NotAVideoError } from './probe.ts';

export type TaskHandler = (task: StartMediaTask, context: StepContext) => Promise<Omit<MediaTaskResult, 'seconds'>>;

/** Finished tasks answer GET /v1/tasks/:id for this long, for a caller that missed the callback. */
const KEEP_FINISHED_MS = 60 * 60 * 1000;
/** Progress callbacks at most this often (stage changes always go). */
const PROGRESS_EVERY_MS = 400;
/** Retries of the final callback, in ms. */
const FINAL_RETRIES = [500, 1000, 2000, 4000, 8000];

interface Entry {
  status: MediaTaskStatus;
  callback: string | undefined;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * The tasks this service is running or ran recently. A task reports progress
 * and its result to its callback, and to GET /v1/tasks/:id. Ids are the
 * caller's, so a repeated start returns the task already running.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, Entry>();
  private readonly handler: TaskHandler;
  private readonly workRoot: string;
  private work: Promise<string> | undefined;

  constructor(handler: TaskHandler, workRoot: string) {
    this.handler = handler;
    this.workRoot = workRoot;
  }

  start(task: StartMediaTask): MediaTaskStatus {
    const existing = this.tasks.get(task.id);
    if (existing) return existing.status;
    const status: MediaTaskStatus = { id: task.id, op: task.op, status: 'running', progress: 0 };
    const entry: Entry = { status, callback: task.callback, controller: new AbortController(), done: Promise.resolve() };
    this.tasks.set(task.id, entry);
    entry.done = this.run(task, entry);
    return status;
  }

  get(id: string): MediaTaskStatus | undefined {
    return this.tasks.get(id)?.status;
  }

  /** Aborts a running task; it then fails with `cancelled`. */
  cancel(id: string): MediaTaskStatus | undefined {
    const entry = this.tasks.get(id);
    if (entry?.status.status === 'running') entry.controller.abort();
    return entry?.status;
  }

  get running(): number {
    return [...this.tasks.values()].filter((e) => e.status.status === 'running').length;
  }

  /** Resolves once every task has finished (tests and shutdown). */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.tasks.values()].map((e) => e.done));
  }

  /** A scratch folder per task, under one folder per process (so two services never clean up each other's work). */
  private async workDir(id: string): Promise<string> {
    this.work ??= mkdir(this.workRoot, { recursive: true }).then(() => mkdtemp(join(this.workRoot, 'run-')));
    const dir = join(await this.work, id);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async run(task: StartMediaTask, entry: Entry): Promise<void> {
    const { status, controller } = entry;
    const started = performance.now();
    let lastSent = 0;
    const progress = (p: number, stage?: string) => {
      if (status.status !== 'running') return;
      const stageChanged = stage !== undefined && stage !== status.stage;
      status.progress = Math.max(0, Math.min(1, p));
      if (stage !== undefined) status.stage = stage;
      const now = performance.now();
      if (!stageChanged && now - lastSent < PROGRESS_EVERY_MS) return;
      lastSent = now;
      void this.send(entry, { type: 'progress', id: status.id, progress: status.progress, ...(status.stage ? { stage: status.stage } : {}) }, false);
    };
    let work: string | undefined;
    try {
      work = await this.workDir(task.id);
      const result = await this.handler(task, { work, progress, signal: controller.signal });
      controller.signal.throwIfAborted();
      Object.assign(status, { status: 'done', progress: 1, result: { ...result, seconds: Math.round(performance.now() - started) / 1000 } });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = cancelled ? 'cancelled' : error instanceof Error ? error.message : String(error);
      if (!cancelled) console.warn(`media task ${task.id} (${task.op}) failed:`, message);
      Object.assign(status, { status: 'failed', error: message, code: cancelled ? 'cancelled' : error instanceof NotAVideoError ? 'not_a_video' : 'failed' });
    } finally {
      if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
    delete status.stage;
    const event: MediaTaskEvent =
      status.status === 'done'
        ? { type: 'done', id: status.id, result: status.result! }
        : { type: 'failed', id: status.id, error: status.error!, code: status.code ?? 'failed' };
    await this.send(entry, event, true);
    setTimeout(() => this.tasks.delete(task.id), KEEP_FINISHED_MS).unref();
  }

  /** POSTs an event to the task's callback. The final one is retried; a 404 or 410 means the caller has gone. */
  private async send(entry: Entry, event: MediaTaskEvent, final: boolean): Promise<void> {
    const { callback } = entry;
    if (!callback) return;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(callback, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
        if (res.ok || res.status === 404 || res.status === 410 || !final) return;
        throw new Error(`${res.status}`);
      } catch (error) {
        if (!final || attempt >= FINAL_RETRIES.length) {
          if (final) console.warn(`media task ${event.id}: callback ${showUrl(callback)} failed:`, error instanceof Error ? error.message : error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, FINAL_RETRIES[attempt]));
      }
    }
  }
}
