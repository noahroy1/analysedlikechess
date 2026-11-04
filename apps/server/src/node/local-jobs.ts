import { EventEmitter } from 'node:events';
import { JOB_KINDS, type Job, type JobKind, type JobState } from '@als/schema';
import type { EventBus, JobHandler, JobRunner, StartJob } from '../ports.ts';

/** Minimum gap between progress broadcasts for one job. Status changes always go out. */
const THROTTLE_MS = 150;

type AnyJob = Job;
interface Entry {
  job: AnyJob;
  userId: string;
  request: unknown;
  controller: AbortController;
  lastSent?: { at: number; signature: string };
}

/** What makes an update urgent: a status change of the job or any of its stages. */
function signature(job: AnyJob): string {
  if (job.kind === 'render') return `${job.state.status}:${job.state.stage ?? ''}`;
  return job.state.status + job.state.stages.map((s) => s.status).join();
}

/**
 * Jobs in this process, one kind at a time each (ffmpeg and the renderer
 * already use every core) and at most one per project and kind. A restart
 * loses the queue; the bootstrap requeues what project state says was unfinished.
 */
export class LocalJobRunner implements JobRunner {
  private readonly events: EventBus;
  private readonly handlers = new Map<JobKind, JobHandler<JobKind>>();
  private readonly entries = new Map<string, Entry>();
  private readonly waiting = new Map<JobKind, string[]>(JOB_KINDS.map((k) => [k, []]));
  private readonly running = new Map<JobKind, string>();
  private readonly drains = new Map<JobKind, Promise<void>>();
  private readonly idle = new EventEmitter();

  constructor(events: EventBus) {
    this.events = events;
  }

  register<K extends JobKind>(kind: K, handler: JobHandler<K>): void {
    this.handlers.set(kind, handler as unknown as JobHandler<JobKind>);
  }

  start<K extends JobKind>(kind: K, projectId: string, start: StartJob<K>): { job: Extract<Job, { kind: K }>; created: boolean } {
    const existing = this.find(kind, projectId);
    if (existing) return { job: existing, created: false };
    const job = { id: crypto.randomUUID(), kind, projectId, state: structuredClone(start.state) } as unknown as Extract<Job, { kind: K }>;
    this.entries.set(job.id, { job, userId: start.userId, request: start.request, controller: new AbortController() });
    this.waiting.get(kind)!.push(job.id);
    this.send(this.entries.get(job.id)!, true);
    if (!this.running.has(kind)) this.drains.set(kind, this.drain(kind));
    return { job: structuredClone(job), created: true };
  }

  find<K extends JobKind>(kind: K, projectId: string): Extract<Job, { kind: K }> | undefined {
    for (const { job } of this.entries.values()) {
      if (job.kind === kind && job.projectId === projectId) return structuredClone(job) as Extract<Job, { kind: K }>;
    }
    return undefined;
  }

  list(userId: string): Job[] {
    return [...this.entries.values()].filter((e) => e.userId === userId).map((e) => structuredClone(e.job));
  }

  cancel(jobId: string): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return false;
    const queue = this.waiting.get(entry.job.kind)!;
    const at = queue.indexOf(jobId);
    if (at >= 0) {
      queue.splice(at, 1);
      this.entries.delete(jobId);
      this.notifyIdle();
    } else {
      entry.controller.abort();
    }
    return true;
  }

  async whenIdle(): Promise<void> {
    while (this.entries.size) await new Promise((resolve) => this.idle.once('idle', resolve));
  }

  private async drain(kind: JobKind) {
    const queue = this.waiting.get(kind)!;
    for (let id = queue.shift(); id; id = queue.shift()) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      this.running.set(kind, id);
      const handler = this.handlers.get(kind);
      try {
        if (!handler) throw new Error(`no handler for ${kind} jobs`);
        await handler({
          job: structuredClone(entry.job) as never,
          userId: entry.userId,
          request: entry.request,
          signal: entry.controller.signal,
          report: (state: JobState<JobKind>) => {
            entry.job = { ...entry.job, state: structuredClone(state) } as AnyJob;
            this.send(entry);
          },
        });
      } catch (error) {
        // Handlers record their own failures in project state; this is e.g. a project deleted mid-run.
        console.error(`${kind} job for ${entry.job.projectId} failed:`, error);
      }
      this.entries.delete(id);
      this.running.delete(kind);
      this.notifyIdle();
    }
  }

  private notifyIdle() {
    this.idle.emit('idle');
  }

  private send(entry: Entry, force = false) {
    const sig = signature(entry.job);
    const now = performance.now();
    if (!force && entry.lastSent && entry.lastSent.signature === sig && now - entry.lastSent.at < THROTTLE_MS) return;
    entry.lastSent = { at: now, signature: sig };
    this.events.publish(entry.userId, structuredClone(entry.job));
  }
}
