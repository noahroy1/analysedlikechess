import { toJsonSchema } from '@als/schema';
import { costUsd } from '../prices.ts';
import { ProviderError, type Analyst, type AnalystCall } from './types.ts';

const ENDPOINT = 'https://api.openai.com/v1/responses';
/** A flex call still running after this is cancelled and rerun on standard; a standard one fails. */
const DEADLINE_MS = { flex: 10 * 60 * 1000, default: 15 * 60 * 1000 };
/** Polls that may fail in a row (a network blip) before the call gives up. */
const POLL_RETRIES = 5;
/** Explicit cache breakpoints exist from gpt-5.6 on; older models cache implicitly and reject them. */
const EXPLICIT_CACHE = /^gpt-(5\.([6-9]|\d{2,})|([6-9]|\d{2,})(\.|-|$))/;

export interface OpenAIOptions {
  apiKey: string;
  record?: (name: string, raw: unknown) => Promise<void>;
  /** How often to poll a background response. */
  pollMs?: number;
  /** Tier for non-interactive calls (default flex). */
  tier?: 'flex' | 'default';
}

interface ResponseBody {
  id?: string;
  status?: string;
  model?: string;
  service_tier?: string;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

/**
 * Strict structured outputs take a subset of JSON Schema. Zod already closes
 * every object and requires every field (optional ones are nullable), so only
 * the `$schema` tag and z.int()'s safe-integer bounds are removed.
 */
export function strictSchema(schema: AnalystCall<unknown>['schema']): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$schema') continue;
      if ((key === 'minimum' || key === 'maximum') && Math.abs(value as number) === Number.MAX_SAFE_INTEGER) continue;
      out[key] = strip(value);
    }
    return out;
  };
  return strip(toJsonSchema(schema)) as Record<string, unknown>;
}

/**
 * OpenAI's Responses API with strict structured outputs, called with fetch.
 * Requests run in background mode and are polled: a reasoning call can take
 * minutes (Pass B on flex took over 13 in testing), longer than one HTTP
 * request reliably stays open. `store: false` still applies; OpenAI keeps a
 * background response for about 10 minutes so it can be polled.
 * Pipeline stages ask for the Flex tier (half price, may queue) and fall back
 * to standard when Flex has no capacity or runs past its deadline; Regenerate
 * and Re-evaluate use standard. Those interactive calls end the system prompt
 * and the scene timeline at explicit cache breakpoints, so a repeat reads them
 * from the cache and the per-call task is never written to it.
 */
export function openaiAnalyst({ apiKey, record, pollMs = 1500, tier: pipelineTier = 'flex' }: OpenAIOptions): Analyst {
  async function send(path: string, body?: unknown): Promise<{ res: Response; json: ResponseBody }> {
    try {
      const res = await fetch(`${ENDPOINT}${path}`, {
        method: body === undefined && path ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { res, json: (await res.json().catch(() => ({}))) as ResponseBody };
    } catch (error) {
      const cause = (error as Error & { cause?: Error }).cause?.message;
      throw new ProviderError(`Could not reach OpenAI: ${(error as Error).message}${cause ? ` (${cause})` : ''}`);
    }
  }

  async function request(call: AnalystCall<unknown>, tier: 'flex' | 'default'): Promise<ResponseBody> {
    // The output schema is part of the cached prefix, so pipeline passes (one schema each) never reuse
    // each other's cache and a write would cost 1.25x for nothing. Interactive calls repeat with the same
    // schema (Regenerate, Re-evaluate), so only they set breakpoints; the rest send caching off.
    const explicit = EXPLICIT_CACHE.test(call.model);
    const cached = explicit && call.interactive === true;
    const breakpoint = cached ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {};
    const { res, json } = await send('', {
      model: call.model,
      background: true,
      service_tier: tier,
      store: false,
      max_output_tokens: 64000,
      reasoning: { effort: call.effort },
      ...(explicit ? { prompt_cache_options: { mode: 'explicit' } } : {}),
      text: { format: { type: 'json_schema', name: call.name, strict: true, schema: strictSchema(call.schema) } },
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: call.system, ...breakpoint }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: call.context, ...breakpoint },
            { type: 'input_text', text: call.task },
          ],
        },
      ],
    });
    if (!res.ok) {
      // Flex has no capacity (429 Resource Unavailable, not billed) or timed out: retry on standard.
      if (tier === 'flex' && (res.status === 429 || res.status === 408) && json.error?.code !== 'insufficient_quota') {
        return request(call, 'default');
      }
      if (res.status === 401) throw new ProviderError('The OpenAI API key was rejected');
      if (json.error?.code === 'insufficient_quota') throw new ProviderError('The OpenAI account is out of credit');
      if (json.error?.code === 'model_not_found') throw new ProviderError(`OpenAI: ${json.error.message} (allow it in the project's model settings)`);
      if (res.status === 429) throw new ProviderError('OpenAI rate limit reached; try again shortly');
      throw new ProviderError(`OpenAI request failed (${res.status}): ${json.error?.message ?? res.statusText}`);
    }

    let body = json;
    const deadline = Date.now() + DEADLINE_MS[tier];
    let failures = 0;
    while (body.status === 'queued' || body.status === 'in_progress') {
      if (Date.now() > deadline) {
        await send(`/${body.id}/cancel`, {}).catch(() => undefined);
        if (tier === 'flex') return request(call, 'default');
        throw new ProviderError(`OpenAI took too long on the ${call.name} step`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      try {
        const poll = await send(`/${body.id}`);
        if (!poll.res.ok) throw new ProviderError(`OpenAI lost the ${call.name} response (${poll.res.status}): ${poll.json.error?.message ?? ''}`);
        body = poll.json;
        failures = 0;
      } catch (error) {
        if (++failures > POLL_RETRIES) throw error;
      }
    }
    return body;
  }

  return {
    async run(call) {
      const body = await request(call, call.interactive ? 'default' : pipelineTier);
      if (body.status === 'incomplete') {
        const reason = body.incomplete_details?.reason;
        throw new ProviderError(
          reason === 'max_output_tokens' ? `OpenAI ran out of room on the ${call.name} step` : `OpenAI stopped the ${call.name} step early (${reason ?? 'no reason given'})`,
        );
      }
      if (body.status !== 'completed') throw new ProviderError(`OpenAI's ${call.name} step ${body.status ?? 'failed'}: ${body.error?.message ?? ''}`.trim());
      const content = (body.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
      const refusal = content.find((c) => c.type === 'refusal');
      if (refusal) throw new ProviderError(`OpenAI declined the ${call.name} step: ${refusal.refusal ?? ''}`.trim());
      const text = content.find((c) => c.type === 'output_text')?.text;
      let json: unknown;
      try {
        json = JSON.parse(text ?? '');
      } catch {
        throw new ProviderError(`OpenAI's ${call.name} output was not JSON`);
      }
      const parsed = call.schema.safeParse(json);
      if (!parsed.success) throw new ProviderError(`OpenAI's ${call.name} output did not match the schema`);

      // input_tokens includes cache reads and writes; each token is billed at one of the three rates.
      const u = body.usage;
      const cacheReadTokens = u?.input_tokens_details?.cached_tokens ?? 0;
      const cacheWriteTokens = u?.input_tokens_details?.cache_write_tokens ?? 0;
      const usage = {
        inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cacheReadTokens - cacheWriteTokens),
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens,
        cacheWriteTokens,
      };
      // Responses name a dated snapshot ("gpt-6-luna-2026-05-18"); prices are per model and tier.
      const model = (body.model ?? call.model).replace(/-\d{4}-\d{2}-\d{2}$/, '');
      const priced = body.service_tier === 'flex' ? `${model}:flex` : model;
      await record?.(`openai-${call.name}`, { output: parsed.data, model: priced, usage });
      return { output: parsed.data, model: `openai/${priced}`, usage, costUsd: costUsd(priced, usage) };
    },
  };
}
