import { SoundIdSchema, type SoundBank } from '@als/schema';
import type { SoundSource } from '../ports.ts';
import type { Db } from './db.ts';

/**
 * The sound bank from `app.sounds`: one row per file in R2 (`sounds/<id>.<ext>`)
 * with its length, probed when it was loaded (`scripts/load-sounds.ts`), so
 * nothing probes files per request. Ids the app doesn't know are skipped.
 */
export class PgSoundSource implements SoundSource {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async bank(src: (file: string) => string): Promise<SoundBank> {
    const { rows } = await this.db.tx((sql) => sql.query<{ id: string; ext: string; duration_sec: string }>('select id, ext, duration_sec from app.sounds order by id'));
    const bank: SoundBank = {};
    for (const row of rows) {
      const id = SoundIdSchema.safeParse(row.id);
      if (id.success) bank[id.data] = { src: src(`${row.id}.${row.ext}`), durationSec: Number(row.duration_sec) };
    }
    return bank;
  }
}
