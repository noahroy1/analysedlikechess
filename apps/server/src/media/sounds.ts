import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SoundIdSchema, type SoundBank } from '@als/schema';
import { run } from './run.ts';

/** Sound files the browser and the renderer can both decode. */
export const SOUND_FILE = /^([a-z0-9-]+)\.(wav|mp3|ogg|m4a|aac|flac)$/;

/** URL a sound file is served at. */
export const soundUrl = (file: string) => `/api/sounds/${file}`;

/**
 * The chess sounds in a folder (`<id>.<ext>`, see SOUND_IDS), with their
 * lengths. Probed lengths are cached by file size and time, so dropping a new
 * file in shows up on the next request. A missing folder is an empty bank.
 */
export class SoundLibrary {
  private readonly durations = new Map<string, { key: string; durationSec: number }>();

  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async bank(): Promise<SoundBank> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const bank: SoundBank = {};
    for (const file of files.sort()) {
      const match = SOUND_FILE.exec(file);
      const id = SoundIdSchema.safeParse(match?.[1]);
      if (!id.success || bank[id.data]) continue;
      const durationSec = await this.duration(file).catch(() => 0);
      if (durationSec > 0) bank[id.data] = { src: soundUrl(file), durationSec };
    }
    return bank;
  }

  /** Path of a servable file, or undefined. */
  path(file: string): string | undefined {
    const id = SoundIdSchema.safeParse(SOUND_FILE.exec(file)?.[1]);
    return id.success ? join(this.dir, file) : undefined;
  }

  private async duration(file: string): Promise<number> {
    const info = await stat(join(this.dir, file));
    const key = `${info.size}:${info.mtimeMs}`;
    const cached = this.durations.get(file);
    if (cached?.key === key) return cached.durationSec;
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(this.dir, file)]);
    const durationSec = Number(out.trim());
    this.durations.set(file, { key, durationSec });
    return durationSec;
  }
}
