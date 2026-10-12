import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { UsageSchema } from '@als/schema';
import { costUsd } from '../prices.ts';
import { GeminiNotesSchema, GeminiRegionsSchema, parseNotes, parseRegions } from './gemini.ts';
import { parseScribe } from './elevenlabs.ts';
import { ProviderError, type Analyst, type Providers } from './types.ts';

// Tests never call cloud APIs: they replay one real response per provider,
// recorded with ANALYSIS_RECORD_DIR. The same replay lets the app run without keys.

const RecordedClaude = z.object({ output: z.unknown(), model: z.string(), usage: UsageSchema });
const UsageMetadata = z.looseObject({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional() }).optional();
const RecordedGemini = z.object({ raw: GeminiNotesSchema, usageMetadata: UsageMetadata });
const RecordedRegions = z.object({ raw: GeminiRegionsSchema, usageMetadata: UsageMetadata });

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
    // One recorded frame answers for every frame.
    regions: {
      async find() {
        const recorded = RecordedRegions.parse(await readJson(dir, 'gemini-regions'));
        const usage = {
          inputTokens: recorded.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: recorded.usageMetadata?.candidatesTokenCount ?? 0,
        };
        return { ...parseRegions(recorded.raw), model: 'replay/gemini-regions', usage, costUsd: costUsd('gemini-3.5-flash-lite', usage) };
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
