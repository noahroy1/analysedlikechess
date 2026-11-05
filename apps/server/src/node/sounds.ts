import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SOUND_FILE, SoundIdSchema, type SoundBank } from '@als/schema';
import type { SoundSource } from '../ports.ts';

/**
 * The chess sounds in a folder (`<id>.<ext>`, see SOUND_IDS), with their
 * lengths. Probed lengths are cached by file size and time, so dropping a new
 * file in shows up on the next request. A missing folder is an empty bank.
 */
export class SoundLibrary implements SoundSource {
  private readonly durations = new Map<string, { key: string; durationSec: number }>();

  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** The bank, with each file's URL from `src` (signed by the caller). */
  async bank(src: (file: string) => string): Promise<SoundBank> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const bank: SoundBank = {};
    for (const file of files.sort()) {
      const match = SOUND_FILE.exec(file);
      const id = SoundIdSchema.safeParse(match?.[1]);
      if (!id.success || bank[id.data]) continue;
      const durationSec = await this.duration(file).catch(() => 0);
      if (durationSec > 0) bank[id.data] = { src: src(file), durationSec };
    }
    return bank;
  }

  private async duration(file: string): Promise<number> {
    const info = await stat(join(this.dir, file));
    const key = `${info.size}:${info.mtimeMs}`;
    const cached = this.durations.get(file);
    if (cached?.key === key) return cached.durationSec;
    // C3 keeps the lengths in a `sounds` table, probed at upload, so this ffprobe goes with the Node server.
    const { stdout: out } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(this.dir, file)]);
    const durationSec = Number(out.trim());
    this.durations.set(file, { key, durationSec });
    return durationSec;
  }
}
