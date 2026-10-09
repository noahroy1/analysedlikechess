import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { UsageSchema } from '@als/schema';
import { costUsd } from '../prices.ts';
import { GeminiNotesSchema, parseNotes } from './gemini.ts';
import { parseScribe } from './elevenlabs.ts';
import { ProviderError, type Providers } from './types.ts';

// Tests never call cloud APIs: they replay one real response per provider,
// recorded with ANALYSIS_RECORD_DIR. The same replay lets the app run without keys.

const RecordedClaude = z.object({ output: z.unknown(), model: z.string(), usage: UsageSchema });
const RecordedGemini = z.object({
  raw: GeminiNotesSchema,
  usageMetadata: z.looseObject({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional() }).optional(),
});

async function readJson(dir: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'));
  } catch {
    throw new ProviderError(`No recorded ${name} response in ${dir}`);
  }
}

/** Saves raw provider responses as `<dir>/<name>.json`. */
export const recorder = (dir: string) => async (name: string, raw: unknown) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(raw, null, 2)}\n`);
};

export function replayProviders(dir: string): Providers {
  return {
    transcriber: {
      async transcribe(_audio, { durationSec }) {
        const usage = { audioSec: durationSec };
        return { transcript: parseScribe(await readJson(dir, 'elevenlabs')), model: 'replay/scribe_v2', usage, costUsd: costUsd('scribe_v2', usage) };
      },
    },
    describer: {
      async describe(_video, { durationSec }) {
        const recorded = RecordedGemini.parse(await readJson(dir, 'gemini'));
        const usage = {
          inputTokens: recorded.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: recorded.usageMetadata?.candidatesTokenCount ?? 0,
        };
        return { notes: parseNotes(recorded.raw, durationSec), model: 'replay/gemini', usage, costUsd: costUsd('gemini-3.5-flash-lite', usage) };
      },
    },
    analyst: {
      async run(call) {
        const recorded = RecordedClaude.parse(await readJson(dir, `claude-${call.name}`));
        // Same validation as a live call: a stale recording fails loudly.
        const output = call.schema.parse(recorded.output);
        return { output, model: `replay/${recorded.model}`, usage: recorded.usage, costUsd: costUsd(recorded.model, recorded.usage) };
      },
    },
  };
}
