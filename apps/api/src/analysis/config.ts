import { fileURLToPath } from 'node:url';

/**
 * Which provider and model does each job. All of it comes from the server's
 * `.env`; nothing here reaches the browser.
 */
export interface AnalysisConfig {
  keys: { anthropic?: string; openai?: string; gemini?: string; elevenlabs?: string };
  models: {
    /** Speech-to-text with word timestamps and diarization. */
    transcriber: string;
    /** Video understanding for scene notes. */
    scene: string;
    /** The cheap call that maps speaker labels to character names. */
    naming: string;
    /** Pass A and full Pass B. */
    analyst: string;
    /** Single-moment Regenerate, faster. */
    regen: string;
    /** Faces and the move's subject on a frozen frame, for placing cards. */
    regions: string;
  };
  /** OpenAI tier for pipeline stages: `flex` is half price but queues; `default` is standard. Interactive calls always use standard. */
  openaiTier: 'flex' | 'default';
  /** Run analysis on its own once ingest finishes. */
  autoAnalyze: boolean;
  /** Frames per second Gemini samples from the proxy (it defaults to 1). */
  sceneFps: number;
  /** Replay recorded provider responses from this folder instead of calling the APIs. */
  replayDir?: string;
  /**
   * Dev only: instead of calling the LLM, write each request to this folder and
   * read the answer from `claude-<call>.json` beside it (hand-written, e.g. by a
   * Claude Code session). Lets analysis run before an API balance exists.
   */
  handoffDir?: string;
  /** Record every provider response into this folder (to refresh fixtures). */
  recordDir?: string;
  styleCorpusPath: string;
}

export function loadAnalysisConfig(env: NodeJS.ProcessEnv = process.env): AnalysisConfig {
  const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  return {
    keys: {
      anthropic: blank(env.ANTHROPIC_API_KEY),
      openai: blank(env.OPENAI_API_KEY),
      gemini: blank(env.GEMINI_API_KEY),
      elevenlabs: blank(env.ELEVENLABS_API_KEY),
    },
    models: {
      transcriber: blank(env.TRANSCRIBER_MODEL) ?? 'scribe_v2',
      scene: blank(env.SCENE_MODEL) ?? 'gemini-3.5-flash-lite',
      // GPT-6 Luna for every LLM call (chosen Oct 13, 2026, cost first). A `claude-` model goes to Anthropic.
      naming: blank(env.NAMING_MODEL) ?? 'gpt-6-luna',
      analyst: blank(env.ANALYST_MODEL) ?? 'gpt-6-luna',
      regen: blank(env.REGEN_MODEL) ?? 'gpt-6-luna',
      regions: blank(env.REGIONS_MODEL) ?? 'gemini-3.5-flash-lite',
    },
    openaiTier: blank(env.OPENAI_TIER) === 'standard' ? 'default' : 'flex',
    autoAnalyze: (blank(env.AUTO_ANALYZE) ?? 'true') !== 'false',
    sceneFps: Number(blank(env.SCENE_FPS) ?? 1),
    replayDir: blank(env.ANALYSIS_REPLAY_DIR),
    handoffDir: blank(env.ANALYST_HANDOFF_DIR),
    recordDir: blank(env.ANALYSIS_RECORD_DIR),
    styleCorpusPath: blank(env.STYLE_CORPUS) ?? fileURLToPath(new URL('../../../../style/corpus.json', import.meta.url)),
  };
}

/** Claude models go to Anthropic; every other LLM model to OpenAI. */
export const isClaude = (model: string) => model.startsWith('claude-');

/** Keys a full analysis needs; empty when it can run. */
export function missingKeys(config: AnalysisConfig): string[] {
  if (config.replayDir) return [];
  const missing: string[] = [];
  if (!config.keys.elevenlabs) missing.push('ELEVENLABS_API_KEY');
  if (!config.keys.gemini) missing.push('GEMINI_API_KEY');
  if (!config.handoffDir) {
    const { naming, analyst, regen } = config.models;
    const llms = [naming, analyst, regen];
    if (llms.some(isClaude) && !config.keys.anthropic) missing.push('ANTHROPIC_API_KEY');
    if (!llms.every(isClaude) && !config.keys.openai) missing.push('OPENAI_API_KEY');
  }
  return missing;
}
