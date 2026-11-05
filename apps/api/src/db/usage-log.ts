import { EDITOR_CALLS, UsageEntrySchema, type ProjectUsage, type UsageEntry } from '@als/schema';
import type { UsageLog } from '../ports.ts';
import type { Db } from './db.ts';

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Spend in `app.usage`, one row per paid call, in the current scope (a user records and reads only their own). */
export class PgUsageLog implements UsageLog {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async record(input: Omit<UsageEntry, 'at'> & { at?: string }): Promise<void> {
    const entry = UsageEntrySchema.parse({ ...input, costUsd: round6(input.costUsd), at: input.at ?? new Date().toISOString() });
    await this.db.tx((sql) =>
      sql.query(
        `insert into app.usage (user_id, project_id, call, model, usage, cost_usd, container_sec, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.userId,
          entry.projectId,
          entry.call,
          entry.model ?? null,
          entry.usage ? JSON.stringify(entry.usage) : null,
          entry.costUsd,
          entry.containerSec ?? null,
          entry.at,
        ],
      ),
    );
  }

  async monthToDate(userId: string, now = new Date()): Promise<number> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const { rows } = await this.db.tx((sql) =>
      sql.query<{ total: string }>('select coalesce(sum(cost_usd), 0) as total from app.usage where user_id = $1 and at >= $2', [userId, start]),
    );
    return round6(Number(rows[0]?.total ?? 0));
  }

  async projectTotals(projectId: string): Promise<ProjectUsage> {
    const { rows } = await this.db.tx((sql) =>
      sql.query<{ call: string; count: string; cost: string }>(
        `select call, count(*) as count, coalesce(sum(cost_usd), 0) as cost
         from app.usage where project_id = $1 and call = any($2::text[]) group by call`,
        [projectId, [...EDITOR_CALLS]],
      ),
    );
    const total = (call: string) => {
      const row = rows.find((r) => r.call === call);
      return { count: Number(row?.count ?? 0), costUsd: round6(Number(row?.cost ?? 0)) };
    };
    return { regenerate: total('regenerate'), evaluate: total('evaluate'), regions: total('regions') };
  }
}
