import { isClaude, type AnalysisConfig } from '../config.ts';
import { claudeAnalyst } from './claude.ts';
import { scribeTranscriber } from './elevenlabs.ts';
import { geminiDescriber, geminiRegions } from './gemini.ts';
import { openaiAnalyst } from './openai.ts';
import { handoffAnalyst, recorder, replayProviders } from './replay.ts';
import { ProviderError, type Providers } from './types.ts';

export * from './types.ts';

/** Live providers from the config, or recorded ones when ANALYSIS_REPLAY_DIR is set. */
export function makeProviders(config: AnalysisConfig): Providers {
  if (config.replayDir) return replayProviders(config.replayDir);
  const record = config.recordDir ? recorder(config.recordDir) : undefined;
  const need = (key: string | undefined, name: string) => {
    if (!key) throw new ProviderError(`Add ${name} to apps/server/.env`);
    return key;
  };
  // Constructed lazily so a missing key fails the stage that needs it, with a clear message.
  return {
    transcriber: {
      transcribe: (...args) =>
        scribeTranscriber({ apiKey: need(config.keys.elevenlabs, 'ELEVENLABS_API_KEY'), model: config.models.transcriber, record }).transcribe(...args),
    },
    describer: {
      describe: (...args) =>
        geminiDescriber({ apiKey: need(config.keys.gemini, 'GEMINI_API_KEY'), model: config.models.scene, fps: config.sceneFps, record }).describe(...args),
    },
    regions: {
      find: (...args) => geminiRegions({ apiKey: need(config.keys.gemini, 'GEMINI_API_KEY'), model: config.models.regions, record }).find(...args),
    },
    analyst: {
      run: (call) =>
        config.handoffDir
          ? handoffAnalyst(config.handoffDir).run(call)
          : isClaude(call.model)
            ? claudeAnalyst({ apiKey: need(config.keys.anthropic, 'ANTHROPIC_API_KEY'), record }).run(call)
            : openaiAnalyst({ apiKey: need(config.keys.openai, 'OPENAI_API_KEY'), record, tier: config.openaiTier }).run(call),
    },
  };
}
