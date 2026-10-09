import { EventEmitter } from 'node:events';
import type { Ingest, IngestEvent } from '@als/schema';
import type { ProjectStore } from '../projects/store.ts';
import { runIngest } from './ingest.ts';

/** Minimum gap between progress broadcasts for one project. Status changes always go out. */
const THROTTLE_MS = 150;

/**
 * Runs ingest jobs one at a time (ffmpeg already uses every core) and
 * broadcasts their live state for the SSE stream.
 */
export class IngestQueue extends EventEmitter<{ update: [IngestEvent] }> {
  private readonly waiting: string[] = [];
  private running: string | undefined;
  private readonly live = new Map<string, Ingest>();
  private readonly lastSent = new Map<string, { at: number; signature: string }>();
  private idle: Promise<void> = Promise.resolve();
  private readonly store: ProjectStore;

  constructor(store: ProjectStore) {
    super();
    this.store = store;
  }

  /** Queues an ingest. Returns false when that project is already queued or running. */
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
  snapshot(): IngestEvent[] {
    return [...this.live].map(([projectId, ingest]) => ({ projectId, ingest: structuredClone(ingest) }));
  }

  /** Resolves once the queue is empty. */
  async whenIdle(): Promise<void> {
    while (this.running || this.waiting.length) await this.idle;
  }

  private async drain() {
    while ((this.running = this.waiting.shift())) {
      const id = this.running;
      try {
        await runIngest(this.store, id, (ingest) => this.publish(id, ingest));
      } catch (error) {
        // runIngest records stage failures itself; this is e.g. a project deleted mid-run.
        console.error(`ingest ${id} failed:`, error);
      }
      this.live.delete(id);
      this.lastSent.delete(id);
    }
  }

  private publish(projectId: string, ingest: Ingest) {
    const signature = ingest.status + ingest.stages.map((s) => s.status).join();
    const last = this.lastSent.get(projectId);
    const now = performance.now();
    this.live.set(projectId, ingest);
    if (last && last.signature === signature && now - last.at < THROTTLE_MS) return;
    this.lastSent.set(projectId, { at: now, signature });
    this.emit('update', { projectId, ingest: structuredClone(ingest) });
  }
}
