import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Recordings } from '../analysis/providers/replay.ts';
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

/** Saves raw provider responses as `<dir>/<name>.json`. */
export const recorder = (dir: string) => async (name: string, raw: unknown) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(raw, null, 2)}\n`);
};

/** Replays the recordings in a folder. */


/**
 * Dev stand-in for Claude. Each call writes `request-<call>.json` (prompts and
 * the JSON schema the answer must match) and reads `claude-<call>.json`, which
 * someone else writes by hand. The answer is validated like a live one. It is
 * labelled and priced as hand-written, so cost logs never claim Claude spend.
 */
export function handoffAnalyst(dir: string): Analyst {
  return {
    async run(call) {
      const answer = join(dir, `claude-${call.name}.json`);
      const raw = await readFile(answer, 'utf8').catch(() => undefined);
      if (raw === undefined) {
        await mkdir(dir, { recursive: true });
        const { model, system, context, task } = call;
        await writeFile(join(dir, `request-${call.name}.json`), `${JSON.stringify({ model, system, context, task, schema: z.toJSONSchema(call.schema) }, null, 2)}\n`);
        throw new ProviderError(`Waiting for a hand-written ${call.name} answer: read request-${call.name}.json, write ${answer}`);
      }
      const { output } = z.object({ output: z.unknown() }).parse(JSON.parse(raw));
      return { output: call.schema.parse(output), model: 'hand-written/claude-code-session', usage: {}, costUsd: 0 };
    },
  };
}
