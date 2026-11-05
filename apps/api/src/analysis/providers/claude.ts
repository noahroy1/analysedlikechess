import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { costUsd } from '../prices.ts';
import { ProviderError, type Analyst } from './types.ts';

/** Models that take the server-side refusal fallback (Haiku has none). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export interface ClaudeOptions {
  apiKey: string;
  record?: (name: string, raw: unknown) => Promise<void>;
}

/**
 * Claude with structured outputs. Streams (Pass B can be long), keeps adaptive
 * thinking on with effort per call, and caches the system prompt and the
 * scene timeline so later passes and Regenerate reuse them.
 */
export function claudeAnalyst({ apiKey, record }: ClaudeOptions): Analyst {
  const client = new Anthropic({ apiKey });
  return {
    async run(call) {
      const fallback = FALLBACK_MODELS.has(call.model);
      const stream = client.beta.messages.stream({
        model: call.model,
        max_tokens: 64000,
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        thinking: { type: 'adaptive' },
        output_config: { effort: call.effort, format: betaZodOutputFormat(call.schema) },
        system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: call.context, cache_control: { type: 'ephemeral' } },
              { type: 'text', text: call.task },
            ],
          },
        ],
      });

      let message;
      try {
        message = await stream.finalMessage();
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) throw new ProviderError('The Anthropic API key was rejected');
        if (error instanceof Anthropic.RateLimitError) throw new ProviderError('Anthropic rate limit reached; try again shortly');
        if (error instanceof Anthropic.APIError) throw new ProviderError(`Claude request failed (${error.status}): ${error.message}`);
        throw error;
      }
      if (message.stop_reason === 'refusal') {
        throw new ProviderError(`Claude declined the ${call.name} step${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}`);
      }
      if (message.stop_reason === 'max_tokens') throw new ProviderError(`Claude ran out of room on the ${call.name} step`);
      if (!message.parsed_output) throw new ProviderError(`Claude's ${call.name} output did not match the schema`);
      const usage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      };
      await record?.(`claude-${call.name}`, { output: message.parsed_output, model: message.model, usage });
      return {
        output: message.parsed_output,
        model: `anthropic/${message.model}`,
        usage,
        costUsd: costUsd(message.model, usage),
      };
    },
  };
}
