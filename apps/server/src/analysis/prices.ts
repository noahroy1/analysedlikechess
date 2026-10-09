import type { Usage } from '@als/schema';

/**
 * Published list prices in USD, checked Oct 10, 2026. Token prices are per
 * million tokens; speech-to-text per hour of audio. Used to log cost per stage
 * so per-clip cost is known before pricing the pitch.
 * TODO(open-decision): re-check before quoting the creator; Gemini 3.x prices rise on Jan 1, 2027.
 */
const TOKEN_PRICES: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  // Fallback models the server may route a refused request to.
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
};

const AUDIO_PRICES_PER_HOUR: Record<string, number> = {
  scribe_v2: 0.22,
};

/** Keyterm prompting adds 20% to Scribe's per-hour price. */
export const SCRIBE_KEYTERM_SURCHARGE = 0.2;

export function costUsd(model: string, usage: Usage, surcharge = 0): number {
  const audio = AUDIO_PRICES_PER_HOUR[model];
  if (audio !== undefined) return ((usage.audioSec ?? 0) / 3600) * audio * (1 + surcharge);
  const price = TOKEN_PRICES[model];
  if (!price) return 0;
  const perToken = (n: number | undefined, rate: number | undefined) => ((n ?? 0) * (rate ?? price.input)) / 1e6;
  return (
    perToken(usage.inputTokens, price.input) +
    perToken(usage.outputTokens, price.output) +
    perToken(usage.cacheReadTokens, price.cacheRead) +
    perToken(usage.cacheWriteTokens, price.cacheWrite)
  );
}
