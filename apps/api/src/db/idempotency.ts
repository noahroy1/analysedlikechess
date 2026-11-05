import { IDEMPOTENCY_TTL_MS } from '@als/schema';
import type { Claim, IdempotencyStore, StoredResponse } from '../../../server/src/api/idempotency.ts';
import type { Db } from './db.ts';

interface KeyRow {
  request_hash: string;
  status: 'running' | 'done';
  response_status: number | null;
  response_headers: [string, string][] | null;
  response_body: Uint8Array | null;
}

/**
 * Idempotency keys in `app.idempotency_keys`, shared by every Worker instance.
 * The rules are the middleware's (apps/server/src/api/idempotency.ts): a
 * repeat replays, another body is a mismatch, a repeat while the first runs
 * waits (by polling the row), and a response not kept (5xx) frees the key.
 */
export class PgIdempotencyStore implements IdempotencyStore {
  private readonly db: Db;
  private readonly ttlMs: number;
  /** A claim still running after this long is taken to be lost (its Worker died) and is taken over. */
  private readonly staleMs: number;
  private readonly pollMs: number;

  constructor(db: Db, options: { ttlMs?: number; staleMs?: number; pollMs?: number } = {}) {
    this.db = db;
    this.ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.staleMs = options.staleMs ?? 5 * 60_000;
    this.pollMs = options.pollMs ?? 250;
  }

  async claim(userId: string, key: string, requestHash: string): Promise<Claim> {
    for (;;) {
      const outcome = await this.db.tx(async (sql) => {
        await sql.query(
          `delete from app.idempotency_keys where user_id = $1 and key = $2
           and (created_at < now() - make_interval(secs => $3) or (status = 'running' and created_at < now() - make_interval(secs => $4)))`,
          [userId, key, this.ttlMs / 1000, this.staleMs / 1000],
        );
        const inserted = await sql.query(
          `insert into app.idempotency_keys (user_id, key, request_hash, status) values ($1, $2, $3, 'running')
           on conflict (user_id, key) do nothing returning 1`,
          [userId, key, requestHash],
        );
        if (inserted.rowCount) return { kind: 'new' as const };
        const { rows } = await sql.query<KeyRow>(
          'select request_hash, status, response_status, response_headers, response_body from app.idempotency_keys where user_id = $1 and key = $2',
          [userId, key],
        );
        return { kind: 'existing' as const, row: rows[0] };
      }, { userId });

      if (outcome.kind === 'new') return { kind: 'new', finish: (response) => this.finish(userId, key, response) };
      const row = outcome.row;
      if (!row) continue; // freed between the insert and the read
      if (row.request_hash !== requestHash) return { kind: 'mismatch' };
      if (row.status === 'done') return { kind: 'replay', response: stored(row) };
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /** Keeps the response, or frees the key when there is none to keep. Returns a promise: on Workers, await it (or `waitUntil`). */
  private async finish(userId: string, key: string, response: StoredResponse | undefined): Promise<void> {
    await this.db.tx(
      (sql) =>
        response
          ? sql.query(
              `update app.idempotency_keys set status = 'done', response_status = $3, response_headers = $4, response_body = $5
               where user_id = $1 and key = $2`,
              [userId, key, response.status, JSON.stringify(response.headers), Buffer.from(response.body)],
            )
          : sql.query(`delete from app.idempotency_keys where user_id = $1 and key = $2 and status = 'running'`, [userId, key]),
      { userId },
    );
  }
}

function stored(row: KeyRow): StoredResponse {
  return {
    status: row.response_status ?? 200,
    headers: row.response_headers ?? [],
    body: new Uint8Array(row.response_body ?? new Uint8Array()),
  };
}
