import type { Job } from '@als/schema';
import type { EventBus } from './ports.ts';

/** The private channel a user's clients subscribe to (`{ config: { private: true } }`); RLS on realtime.messages admits only its owner. */
export const userTopic = (userId: string) => `user:${userId}`;
/** The broadcast event carrying a `Job`, as the dev SSE stream's `job` events did. */
export const JOB_EVENT = 'job';

export interface RealtimeEventBusOptions {
  supabaseUrl: string;
  /** The project's secret key (`sb_secret_…`): server-side only. */
  secretKey: string;
  /** Keeps a send alive after the response (a Worker's `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
  fetch?: typeof fetch;
}

/**
 * Live job updates through Supabase Realtime Broadcast, sent over REST (no
 * socket held open by the Worker). Broadcasts are not stored: clients read
 * `GET /jobs` on every (re)connect and resume, and these fill the time between.
 * A failed send is logged, never thrown: the job carries on.
 */
export class RealtimeEventBus implements EventBus {
  private readonly endpoint: string;
  private readonly secretKey: string;
  private readonly waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RealtimeEventBusOptions) {
    this.endpoint = `${options.supabaseUrl.replace(/\/+$/, '')}/realtime/v1/api/broadcast`;
    this.secretKey = options.secretKey;
    this.waitUntil = options.waitUntil;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  }

  publish(userId: string, job: Job): void {
    const sending = this.send(userId, job);
    this.waitUntil?.(sending);
  }

  /** The send itself, for callers (and tests) that want to wait for it. */
  async send(userId: string, job: Job): Promise<void> {
    const url = `${this.endpoint}/${encodeURIComponent(userTopic(userId))}/events/${JOB_EVENT}?private=true`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { apikey: this.secretKey, Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(job),
      });
      if (!res.ok) console.warn(`broadcast to ${userTopic(userId)} answered ${res.status}: ${await res.text().catch(() => '')}`);
    } catch (error) {
      console.warn(`broadcast to ${userTopic(userId)} failed:`, error);
    }
  }
}
