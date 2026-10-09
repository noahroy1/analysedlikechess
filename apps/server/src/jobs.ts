import { EventEmitter } from 'node:events';

/** Minimum gap between progress broadcasts for one project. Status changes always go out. */
const THROTTLE_MS = 150;

export interface JobUpdate<S> {
  projectId: string;
  state: S;
}

/**
 * Runs one kind of per-project job one at a time and broadcasts its live state
 * (for the SSE stream). A project is queued at most once.
 */
export class JobQueue<S> extends EventEmitter<{ update: [JobUpdate<S>] }> {
  private readonly waiting: string[] = [];
  private running: string | undefined;
  private readonly live = new Map<string, S>();
  private readonly lastSent = new Map<string, { at: number; signature: string }>();
  private idle: Promise<void> = Promise.resolve();
  private readonly run: (projectId: string, onUpdate: (state: S) => void) => Promise<unknown>;
  private readonly signature: (state: S) => string;

  constructor(run: (projectId: string, onUpdate: (state: S) => void) => Promise<unknown>, signature: (state: S) => string) {
    super();
    this.run = run;
    this.signature = signature;
  }

  /** Queues a job. Returns false when that project is already queued or running. */
  enqueue(projectId: string): boolean {
    if (this.has(projectId)) return false;
    this.waiting.push(projectId);
    if (!this.running) this.idle = this.drain();
    return true;
  }

  has(projectId: string): boolean {
    return this.running === projectId || this.waiting.includes(projectId);
  }

  /** Live state of every job still in flight, for clients that just connected. */
  snapshot(): JobUpdate<S>[] {
    return [...this.live].map(([projectId, state]) => ({ projectId, state: structuredClone(state) }));
  }

  /** Resolves once the queue is empty. */
  async whenIdle(): Promise<void> {
    while (this.running || this.waiting.length) await this.idle;
  }

  private async drain() {
    while ((this.running = this.waiting.shift())) {
      const id = this.running;
      try {
        await this.run(id, (state) => this.publish(id, state));
      } catch (error) {
        // Runners record their own stage failures; this is e.g. a project deleted mid-run.
        console.error(`job for ${id} failed:`, error);
      }
      this.live.delete(id);
      this.lastSent.delete(id);
    }
  }

  private publish(projectId: string, state: S) {
    const signature = this.signature(state);
    const last = this.lastSent.get(projectId);
    const now = performance.now();
    this.live.set(projectId, state);
    if (last && last.signature === signature && now - last.at < THROTTLE_MS) return;
    this.lastSent.set(projectId, { at: now, signature });
    this.emit('update', { projectId, state: structuredClone(state) });
  }
}

/** Status of a staged job, for deciding when an update must go out unthrottled. */
export const stageSignature = (job: { status: string; stages: { status: string }[] }) =>
  job.status + job.stages.map((s) => s.status).join();
