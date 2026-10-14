import { afterEach, describe, expect, it, vi } from 'vitest';
import { annotationSchema, decisionPointsSchema, evaluationSchema, MoveDraftSchema, speakerNamingSchema } from '@als/schema';
import { loadAnalysisConfig, missingKeys } from '../config.ts';
import { openaiAnalyst, strictSchema } from './openai.ts';
import { ProviderError, type AnalystCall } from './types.ts';

// No network: fetch is stubbed with Responses API bodies shaped as the API reference documents them.

const call: AnalystCall<{ speakers: { label: string; name: string; confidence: number }[] }> = {
  name: 'speakers',
  model: 'gpt-6-luna',
  effort: 'low',
  system: 'system',
  context: 'context',
  task: 'task',
  schema: speakerNamingSchema(['A']),
};
const answer = { speakers: [{ label: 'A', name: 'Walter White', confidence: 0.9 }] };

const completed = (text: string, extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  model: 'gpt-6-luna-2026-05-18',
  service_tier: 'flex',
  output: [
    { type: 'reasoning', content: [] },
    { type: 'message', content: [{ type: 'output_text', text }] },
  ],
  usage: { input_tokens: 3000, output_tokens: 800, input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 500 } },
  ...extra,
});

function stubFetch(...replies: { status: number; body: unknown }[]) {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      sent.push({ url, method: init.method, ...body });
      const reply = replies.shift()!;
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('strictSchema', () => {
  const schemas = {
    speakers: speakerNamingSchema(['A', 'B']),
    decisions: decisionPointsSchema(['Walt'], ['u1']),
    annotate: annotationSchema(['c1'], ['Walt'], 'long'),
    evaluate: evaluationSchema(['m1']),
    regenerate: MoveDraftSchema,
  };

  it.each(Object.entries(schemas))('makes the %s schema fit strict structured outputs', (_name, schema) => {
    const json = strictSchema(schema);
    expect(json.type).toBe('object');
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      expect(n).not.toHaveProperty('$schema');
      if (n.type === 'integer') expect(n).not.toHaveProperty('minimum');
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false);
        expect(new Set(n.required as string[])).toEqual(new Set(Object.keys(n.properties as object)));
      }
      Object.values(n).forEach(visit);
    };
    visit(json);
  });
});

describe('openaiAnalyst', () => {
  it('sends a strict, uncached, flex request in the background and prices the answer by tier', async () => {
    const sent = stubFetch({ status: 200, body: completed(JSON.stringify(answer)) });
    const result = await openaiAnalyst({ apiKey: 'k' }).run(call);

    expect(result.output).toEqual(answer);
    expect(result.model).toBe('openai/gpt-6-luna:flex');
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 800, cacheReadTokens: 2000, cacheWriteTokens: 500 });
    // Flex: 500 × 0.05 + 800 × 0.25 + 2000 × 0.005 + 500 × 0.0625, per million.
    expect(result.costUsd).toBeCloseTo(0.00026625, 8);

    const body = sent[0]!;
    expect(body).toMatchObject({ model: 'gpt-6-luna', background: true, service_tier: 'flex', store: false, reasoning: { effort: 'low' } });
    expect(body.text).toMatchObject({ format: { type: 'json_schema', name: 'speakers', strict: true } });
    // A pipeline pass has its own schema, so nothing could reuse a cache write: caching is off.
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(JSON.stringify(body.input)).not.toContain('prompt_cache_breakpoint');
  });

  it('polls a background response until it finishes', async () => {
    const sent = stubFetch(
      { status: 200, body: { id: 'resp_1', status: 'queued' } },
      { status: 200, body: { id: 'resp_1', status: 'in_progress' } },
      { status: 200, body: completed(JSON.stringify(answer)) },
    );
    const result = await openaiAnalyst({ apiKey: 'k', pollMs: 1 }).run(call);
    expect(result.output).toEqual(answer);
    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ['POST', 'https://api.openai.com/v1/responses'],
      ['GET', 'https://api.openai.com/v1/responses/resp_1'],
      ['GET', 'https://api.openai.com/v1/responses/resp_1'],
    ]);
  });

  it('rides out a failed poll', async () => {
    stubFetch(
      { status: 200, body: { id: 'resp_1', status: 'in_progress' } },
      { status: 502, body: {} },
      { status: 200, body: completed(JSON.stringify(answer)) },
    );
    expect((await openaiAnalyst({ apiKey: 'k', pollMs: 1 }).run(call)).output).toEqual(answer);
  });

  it('uses the standard tier for interactive calls', async () => {
    const sent = stubFetch({ status: 200, body: completed(JSON.stringify(answer), { service_tier: 'default' }) });
    const result = await openaiAnalyst({ apiKey: 'k' }).run({ ...call, interactive: true });
    expect(sent[0]!.service_tier).toBe('default');
    // Breakpoints after the system prompt and the timeline; the task is never cached.
    const parts = (sent[0]!.input as { content: { text: string; prompt_cache_breakpoint?: unknown }[] }[]).flatMap((m) => m.content);
    expect(parts.map((p) => [p.text, !!p.prompt_cache_breakpoint])).toEqual([
      ['system', true],
      ['context', true],
      ['task', false],
    ]);
    expect(result.model).toBe('openai/gpt-6-luna');
  });

  it('leaves out explicit cache breakpoints for models before gpt-5.6, which reject them', async () => {
    const sent = stubFetch({ status: 200, body: completed(JSON.stringify(answer)) });
    await openaiAnalyst({ apiKey: 'k' }).run({ ...call, model: 'gpt-5-mini' });
    expect(sent[0]).not.toHaveProperty('prompt_cache_options');
    expect(JSON.stringify(sent[0]!.input)).not.toContain('prompt_cache_breakpoint');
  });

  it('runs pipeline calls on standard when configured', async () => {
    const sent = stubFetch({ status: 200, body: completed(JSON.stringify(answer), { service_tier: 'default' }) });
    await openaiAnalyst({ apiKey: 'k', tier: 'default' }).run(call);
    expect(sent[0]!.service_tier).toBe('default');
    expect(loadAnalysisConfig({ OPENAI_TIER: 'standard' }).openaiTier).toBe('default');
    expect(loadAnalysisConfig({}).openaiTier).toBe('flex');
  });

  it('falls back to standard when flex has no capacity', async () => {
    const sent = stubFetch(
      { status: 429, body: { error: { code: 'resource_unavailable', message: 'Resource Unavailable' } } },
      { status: 200, body: completed(JSON.stringify(answer), { service_tier: 'default' }) },
    );
    await openaiAnalyst({ apiKey: 'k' }).run(call);
    expect(sent.map((b) => b.service_tier)).toEqual(['flex', 'default']);
  });

  it('does not retry when the account is out of credit', async () => {
    stubFetch({ status: 429, body: { error: { code: 'insufficient_quota', message: 'quota' } } });
    await expect(openaiAnalyst({ apiKey: 'k' }).run(call)).rejects.toThrow('out of credit');
  });

  it('reports refusals, truncation and off-schema answers as provider errors', async () => {
    stubFetch({ status: 200, body: completed('', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }) });
    await expect(openaiAnalyst({ apiKey: 'k' }).run(call)).rejects.toThrow('declined the speakers step: No.');

    stubFetch({ status: 200, body: completed('{', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) });
    await expect(openaiAnalyst({ apiKey: 'k' }).run(call)).rejects.toThrow('ran out of room');

    stubFetch({ status: 200, body: completed(JSON.stringify({ speakers: [{ label: 'Z', name: 'x', confidence: 1 }] })) });
    await expect(openaiAnalyst({ apiKey: 'k' }).run(call)).rejects.toBeInstanceOf(ProviderError);
  });

  it('names the setting when the project does not allow the model', async () => {
    stubFetch({ status: 404, body: { error: { code: 'model_not_found', message: 'Project does not have access to model `gpt-6-luna`' } } });
    await expect(openaiAnalyst({ apiKey: 'k' }).run(call)).rejects.toThrow("allow it in the project's model settings");
  });
});

describe('analysis keys', () => {
  const base = { ELEVENLABS_API_KEY: 'e', GEMINI_API_KEY: 'g' };

  it('needs the OpenAI key by default and the Anthropic key only for claude- models', () => {
    expect(missingKeys(loadAnalysisConfig(base))).toEqual(['OPENAI_API_KEY']);
    expect(missingKeys(loadAnalysisConfig({ ...base, OPENAI_API_KEY: 'o' }))).toEqual([]);
    expect(missingKeys(loadAnalysisConfig({ ...base, OPENAI_API_KEY: 'o', ANALYST_MODEL: 'claude-opus-5-5' }))).toEqual(['ANTHROPIC_API_KEY']);
  });
});
