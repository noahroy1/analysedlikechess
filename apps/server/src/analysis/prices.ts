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
  // OpenAI, checked Oct 13, 2026 (developers.openai.com/api/docs/pricing), short context (≤272K input).
  // `:flex` is the Flex tier (Batch rates). Output includes reasoning tokens.
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-6-luna:flex': { input: 0.05, output: 0.25, cacheRead: 0.005, cacheWrite: 0.0625 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'gpt-6.1-sol:flex': { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
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

/**
 * Cloudflare Containers, Workers Paid (developers.cloudflare.com/containers/pricing,
 * read Nov 3, 2026; PLAN-CLOUD.md, C0 findings): each instance type's size and
 * the per-second rates for it.
 */
const CONTAINER_TYPES = {
  lite: { vcpu: 1 / 16, memoryGiB: 0.25, diskGB: 2 },
  basic: { vcpu: 1 / 4, memoryGiB: 1, diskGB: 4 },
  'standard-1': { vcpu: 1 / 2, memoryGiB: 4, diskGB: 8 },
  'standard-2': { vcpu: 1, memoryGiB: 6, diskGB: 12 },
  'standard-3': { vcpu: 2, memoryGiB: 8, diskGB: 16 },
  'standard-4': { vcpu: 4, memoryGiB: 12, diskGB: 20 },
} as const;
const CONTAINER_RATES = { vcpuSec: 0.00002, memoryGiBSec: 0.0000025, diskGBSec: 0.00000007 };

export type ContainerType = keyof typeof CONTAINER_TYPES;

export function isContainerType(name: string): name is ContainerType {
  return Object.hasOwn(CONTAINER_TYPES, name);
}

/**
 * What `seconds` of one instance of `type` cost, at its full size and list
 * price: the month's included usage is not subtracted, so a spend cap never
 * counts on it. standard-4 is $0.000111 a second (C0's BB1 render: 346 s, $0.039).
 * TODO(open-decision): C4 checks this against the real bill; if Cloudflare bills
 * CPU by use rather than by size, this is an upper bound.
 */
export function containerCostUsd(type: ContainerType, seconds: number): number {
  const size = CONTAINER_TYPES[type];
  const perSec = size.vcpu * CONTAINER_RATES.vcpuSec + size.memoryGiB * CONTAINER_RATES.memoryGiBSec + size.diskGB * CONTAINER_RATES.diskGBSec;
  return seconds * perSec;
}
