import type { Profile, ProfileStore } from '../ports.ts';
import type { Db } from './db.ts';

/** `app.profiles`, made for every new user by a trigger. A user reads only their own. */
export class PgProfileStore implements ProfileStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async get(userId: string): Promise<Profile> {
    const { rows } = await this.db.tx((sql) =>
      sql.query<{ role: 'user' | 'admin'; monthly_cap_usd: string | null }>('select role, monthly_cap_usd from app.profiles where user_id = $1', [userId]),
    );
    const row = rows[0];
    return { role: row?.role ?? 'user', ...(row?.monthly_cap_usd != null ? { monthlyCapUsd: Number(row.monthly_cap_usd) } : {}) };
  }
}
