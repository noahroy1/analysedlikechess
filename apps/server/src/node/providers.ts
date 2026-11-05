import type { AnalysisConfig } from '../analysis/config.ts';
import { makeProviders as make } from '../analysis/providers/make.ts';
import type { Providers } from '../analysis/providers/types.ts';
import { dirRecordings, handoffAnalyst, recorder } from './replay-providers.ts';

/** Live providers from the config, or recorded ones when ANALYSIS_REPLAY_DIR is set, with folders for recordings and hand-offs. */
export function makeProviders(config: AnalysisConfig): Providers {
  return make(config, {
    ...(config.replayDir ? { replay: dirRecordings(config.replayDir), replayDelayMs: Number(process.env.ANALYSIS_REPLAY_DELAY_MS ?? 0) } : {}),
    ...(config.recordDir ? { record: recorder(config.recordDir) } : {}),
    ...(config.handoffDir ? { handoff: handoffAnalyst(config.handoffDir) } : {}),
  });
}
