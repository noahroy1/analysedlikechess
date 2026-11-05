import { EventEmitter } from 'node:events';
import type { Job } from '@als/schema';
import type { EventBus } from '../ports.ts';

/** Live job updates inside this process; the dev SSE stream subscribes per user. (C3: Realtime Broadcast on `user:<uid>`.) */
export class LocalEventBus implements EventBus {
  private readonly emitter = new EventEmitter<{ job: [string, Job] }>();

  constructor() {
    // One listener per open stream.
    this.emitter.setMaxListeners(0);
  }

  publish(userId: string, job: Job): void {
    this.emitter.emit('job', userId, job);
  }

  subscribe(userId: string, listener: (job: Job) => void): () => void {
    const handler = (to: string, job: Job) => {
      if (to === userId) listener(job);
    };
    this.emitter.on('job', handler);
    return () => this.emitter.off('job', handler);
  }
}
