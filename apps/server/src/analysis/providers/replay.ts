import { z } from 'zod';
import { UsageSchema } from '@als/schema';
import { costUsd } from '../prices.ts';
import { GeminiNotesSchema, GeminiRegionsSchema, parseNotes, parseRegions } from './gemini.ts';
import { parseScribe } from './elevenlabs.ts';
import { ProviderError, type Providers } from './types.ts';

// Tests never call cloud APIs: they replay one real response per provider,
// recorded with ANALYSIS_RECORD_DIR. The same replay lets the app run without keys.

const RecordedAnalyst = z.object({ output: z.unknown(), model: z.string(), usage: UsageSchema });
const UsageMetadata = z.looseObject({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional() }).optional();
const RecordedGemini = z.object({ raw: GeminiNotesSchema, usageMetadata: UsageMetadata });
const RecordedRegions = z.object({ raw: GeminiRegionsSchema, usageMetadata: UsageMetadata });

/** A recorded response by name (`elevenlabs`, `openai-annotate`, …): a folder on Node, bundled JSON on the Worker. */
export type Recordings = (name: string) => Promise<unknown>;

/** Recordings from a map of name to response, e.g. bundled into the Worker. */
export const recordingsFrom =
  (responses: Record<string, unknown>, where = 'the bundled recordings'): Recordings =>
  async (name) => {
    if (!(name in responses)) throw new ProviderError(`No recorded ${name} response in ${where}`);
    return responses[name];
  };

/**
 * Providers that answer from recordings. `delayMs` makes each answer take that
 * long, as a live call would (dev checks that need a job to be mid-run).
 */
export function replayProviders(read: Recordings, options: { delayMs?: number } = {}): Providers {
  const readJson: Recordings = async (name) => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    return read(name);
  };
  return {
    transcriber: {
      async transcribe(_audio, { durationSec }) {
        const usage = { audioSec: durationSec };
        return { transcript: parseScribe(await readJson('elevenlabs')), model: 'replay/scribe_v2', usage, costUsd: costUsd('scribe_v2', usage) };
      },
    },
    describer: {
      async describe(_video, { durationSec }) {
        const recorded = RecordedGemini.parse(await readJson('gemini'));
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
        const recorded = RecordedRegions.parse(await readJson('gemini-regions'));
        const usage = {
          inputTokens: recorded.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: recorded.usageMetadata?.candidatesTokenCount ?? 0,
        };
        return { ...parseRegions(recorded.raw), model: 'replay/gemini-regions', usage, costUsd: costUsd('gemini-3.5-flash-lite', usage) };
      },
    },
    analyst: {
      async run(call) {
        // OpenAI recordings first; the older fixtures are Claude's.
        const raw = await readJson(`openai-${call.name}`).catch(() => readJson(`claude-${call.name}`));
        const recorded = RecordedAnalyst.parse(raw);
        // Same validation as a live call: a stale recording fails loudly.
        const output = call.schema.parse(recorded.output);
        return { output, model: `replay/${recorded.model}`, usage: recorded.usage, costUsd: costUsd(recorded.model, recorded.usage) };
      },
    },
  };
}

