import type { DevFiles } from './analysis/providers/replay.ts';
import type { R2Bucket } from './workers.ts';

/** Dev files live in R2 under this prefix only; the dev routes reach nothing else. */
export const DEV_PREFIX = 'dev/';

/** A dev set's name (ANALYSIS_RECORD_DIR, ANALYST_HANDOFF_DIR): one path segment. */
export function devSetName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error(`Not a dev set name (letters, digits, . _ -): ${name}`);
  return name;
}

/** An R2 prefix as DevFiles (`dev/record/<name>/`, `dev/handoff/<name>/`). */
export function r2Files(bucket: R2Bucket, prefix: string): DevFiles {
  return {
    read: async (name) => (await bucket.get(prefix + name))?.text(),
    async write(name, text) {
      await bucket.put(prefix + name, text);
    },
    // `pnpm dev:files pull` brings these to a folder.
    where: (name) => `R2 ${prefix}${name}`,
  };
}
