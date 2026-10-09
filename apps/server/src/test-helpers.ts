import { fileURLToPath } from 'node:url';
import { loadAnalysisConfig, type AnalysisConfig } from './analysis/config.ts';
import { makeProviders } from './analysis/providers/index.ts';
import { AnalysisService } from './analysis/service.ts';
import { createApp } from './app.ts';
import { createIngestQueue } from './ingest/queue.ts';
import { ProjectStore } from './projects/store.ts';

/** Recorded provider responses for the dialogue fixture; tests never call cloud APIs. */
export const DIALOGUE_RECORDING = fileURLToPath(new URL('../../../fixtures/dialogue/recorded', import.meta.url));

/** The whole server against a scratch projects folder, with replayed providers. */
export async function makeTestApp(root: string, overrides: Partial<AnalysisConfig> = {}) {
  const store = new ProjectStore(root);
  const queue = createIngestQueue(store);
  const config: AnalysisConfig = { ...loadAnalysisConfig({}), autoAnalyze: false, replayDir: DIALOGUE_RECORDING, ...overrides };
  const analysis = await AnalysisService.load(store, makeProviders(config), config);
  return { store, queue, analysis, app: createApp({ store, queue, analysis }) };
}
