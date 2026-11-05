import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handoffAnalyst as handoff, recorder as record, type DevFiles, type Recordings } from '../analysis/providers/replay.ts';
import { ProviderError, type Analyst } from '../analysis/providers/types.ts';

/** Recorded responses as `<dir>/<name>.json`. */
export const dirRecordings =
  (dir: string): Recordings =>
  async (name) => {
    try {
      return JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'));
    } catch {
      throw new ProviderError(`No recorded ${name} response in ${dir}`);
    }
  };

/** A folder as DevFiles. */
export const dirFiles = (dir: string): DevFiles => ({
  read: (name) => readFile(join(dir, name), 'utf8').catch(() => undefined),
  async write(name, text) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), text);
  },
  where: (name) => join(dir, name),
});

/** Saves raw provider responses as `<dir>/<name>.json`. */
export const recorder = (dir: string) => record(dirFiles(dir));

/** The hand-off analyst on a folder. */
export const handoffAnalyst = (dir: string): Analyst => handoff(dirFiles(dir));
