import type { MiddlewareHandler } from 'hono';
import { IDEMPOTENCY_HEADER, IDEMPOTENCY_TTL_MS, IDEMPOTENT_REPLAY_HEADER, IdempotencyKeySchema } from '@als/schema';
import { ApiError, errorResponse } from './errors.ts';

// Every POST, PUT and DELETE takes an Idempotency-Key, so a client can repeat
// any call after a dropped connection:
// - the same key and body replays the stored response;
// - the same key with a different body is a 422;
// - a repeat that arrives while the first is still running waits for it;
// - keys are per user and kept 24 h.
// Server errors (5xx) are not kept, so a retry runs again.

export interface StoredResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}

export type Claim =
  | { kind: 'new'; finish: (response: StoredResponse | undefined) => void }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'mismatch' };

/** Where keys live: memory on Node (C3: the `idempotency_keys` table). */
export interface IdempotencyStore {
  /** Claims a key for a request, waits for a running claim, or returns what was stored. */
  claim(userId: string, key: string, requestHash: string): Promise<Claim>;
}

interface Entry {
  requestHash: string;
  createdAt: number;
  response?: StoredResponse;
  /** Settles when the first call finishes (with its response, or undefined when it was not kept). */
  done: Promise<StoredResponse | undefined>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async claim(userId: string, key: string, requestHash: string): Promise<Claim> {
    this.sweep();
    const id = `${userId}\n${key}`;
    for (;;) {
      const entry = this.entries.get(id);
      if (!entry) break;
      if (entry.requestHash !== requestHash) return { kind: 'mismatch' };
      if (entry.response) return { kind: 'replay', response: entry.response };
      const response = await entry.done;
      if (response) return { kind: 'replay', response };
      // The first call was not kept (a server error): this repeat runs, unless another got in first.
    }
    let settle!: (response: StoredResponse | undefined) => void;
    const entry: Entry = { requestHash, createdAt: this.now(), done: new Promise((resolve) => (settle = resolve)) };
    this.entries.set(id, entry);
    return {
      kind: 'new',
      finish: (response) => {
        if (response) entry.response = response;
        else this.entries.delete(id);
        settle(response);
      },
    };
  }

  private sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) if (entry.createdAt < cutoff && entry.response) this.entries.delete(id);
  }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Headers a replay carries; others (dates, connection details) belong to the original exchange. */
const KEPT_HEADERS = new Set(['content-type', 'etag', 'location']);

export function idempotency(store: IdempotencyStore, options: { skip?: (path: string) => boolean } = {}): MiddlewareHandler<{ Variables: { userId: string } }> {
  return async (c, next) => {
    if (!['POST', 'PUT', 'DELETE'].includes(c.req.method) || options.skip?.(c.req.path)) return next();
    const parsed = IdempotencyKeySchema.safeParse(c.req.header(IDEMPOTENCY_HEADER));
    if (!parsed.success) {
      return errorResponse(c, new ApiError(400, 'idempotency_key_required', `Send an ${IDEMPOTENCY_HEADER} header (8-200 characters) with every POST, PUT and DELETE.`));
    }
    const body = await c.req.arrayBuffer();
    const material = new Uint8Array([...new TextEncoder().encode(`${c.req.method} ${c.req.path}${new URL(c.req.url).search}\n`), ...new Uint8Array(body)]);
    const requestHash = hex(await crypto.subtle.digest('SHA-256', material));

    const claim = await store.claim(c.get('userId'), parsed.data, requestHash);
    if (claim.kind === 'mismatch') {
      return errorResponse(c, new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request.'));
    }
    if (claim.kind === 'replay') {
      const headers = new Headers(claim.response.headers);
      headers.set(IDEMPOTENT_REPLAY_HEADER, 'true');
      return new Response(claim.response.status === 204 ? null : (claim.response.body.slice().buffer as ArrayBuffer), { status: claim.response.status, headers });
    }
    try {
      await next();
    } catch (error) {
      claim.finish(undefined);
      throw error;
    }
    const res = c.res;
    if (res.status >= 500) {
      claim.finish(undefined);
      return;
    }
    const stored: StoredResponse = {
      status: res.status,
      headers: [...res.headers].filter(([name]) => KEPT_HEADERS.has(name.toLowerCase())),
      body: new Uint8Array(await res.clone().arrayBuffer()),
    };
    claim.finish(stored);
  };
}
