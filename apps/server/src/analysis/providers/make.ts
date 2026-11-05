import { isClaude, type AnalysisConfig } from '../config.ts';
import { claudeAnalyst } from './claude.ts';
import { scribeTranscriber } from './elevenlabs.ts';
import { geminiDescriber, geminiRegions } from './gemini.ts';
import { openaiAnalyst } from './openai.ts';
import { replayProviders, type Recordings } from './replay.ts';
import { ProviderError, type Analyst, type Providers } from './types.ts';

/** Where the host keeps recordings and hand-written answers (Node: folders; the Worker: bundled JSON). */
export interface ProviderIo {
  /** Replays these instead of calling any API (ANALYSIS_REPLAY_DIR on Node). */
  replay?: Recordings;
  /** Saves every raw response (ANALYSIS_RECORD_DIR). */
  record?: (name: string, raw: unknown) => Promise<void>;
  /** Stands in for the LLM (ANALYST_HANDOFF_DIR, dev only). */
  handoff?: Analyst;
}

/** Live providers from the config, or recorded ones. Keys are checked per call, so a missing key fails the stage that needs it. */
export function makeProviders(config: AnalysisConfig, io: ProviderIo = {}): Providers {
  if (io.replay) return replayProviders(io.replay);
  const { record, handoff } = io;
  const need = (key: string | undefined, name: string) => {
    if (!key) throw new ProviderError(`Add ${name} to the server's secrets`);
    return key;
  };
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
        handoff
          ? handoff.run(call)
          : isClaude(call.model)
            ? claudeAnalyst({ apiKey: need(config.keys.anthropic, 'ANTHROPIC_API_KEY'), record }).run(call)
            : openaiAnalyst({ apiKey: need(config.keys.openai, 'OPENAI_API_KEY'), record, tier: config.openaiTier }).run(call),
    },
  };
}
