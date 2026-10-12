import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAnalysisConfig, type AnalysisConfig } from './analysis/config.ts';
import { makeProviders } from './analysis/providers/index.ts';
import { AnalysisService } from './analysis/service.ts';
import { createApp } from './app.ts';
import { createIngestQueue } from './ingest/queue.ts';
import { SoundLibrary } from './media/sounds.ts';
import { ProjectStore } from './projects/store.ts';
import { RenderService } from './render/renders.ts';

/** Recorded provider responses for the dialogue fixture; tests never call cloud APIs. */
export const DIALOGUE_RECORDING = fileURLToPath(new URL('../../../fixtures/dialogue/recorded', import.meta.url));

/**
 * The whole server against a scratch projects folder, with replayed providers.
 * Renders load media from `origin`, which only a test that serves the app sets.
 */
export async function makeTestApp(root: string, overrides: Partial<AnalysisConfig> = {}, soundsDir = join(root, 'sounds'), origin = 'http://127.0.0.1:0') {
  const store = new ProjectStore(root);
  const queue = createIngestQueue(store);
  const config: AnalysisConfig = { ...loadAnalysisConfig({}), autoAnalyze: false, replayDir: DIALOGUE_RECORDING, ...overrides };
  const analysis = await AnalysisService.load(store, makeProviders(config), config);
  const sounds = new SoundLibrary(soundsDir);
  const renders = new RenderService({ store, sounds, origin });
  return { store, queue, analysis, renders, app: createApp({ store, queue, analysis, sounds, renders }) };
}
