import claudeAnnotate from '../../../fixtures/dialogue/recorded/claude-annotate.json' with { type: 'json' };
import claudeDecisions from '../../../fixtures/dialogue/recorded/claude-decisions.json' with { type: 'json' };
import claudeEvaluate from '../../../fixtures/dialogue/recorded/claude-evaluate.json' with { type: 'json' };
import claudeRegenerate from '../../../fixtures/dialogue/recorded/claude-regenerate.json' with { type: 'json' };
import claudeSpeakers from '../../../fixtures/dialogue/recorded/claude-speakers.json' with { type: 'json' };
import elevenlabs from '../../../fixtures/dialogue/recorded/elevenlabs.json' with { type: 'json' };
import geminiRegions from '../../../fixtures/dialogue/recorded/gemini-regions.json' with { type: 'json' };
import gemini from '../../../fixtures/dialogue/recorded/gemini.json' with { type: 'json' };

/**
 * Recorded provider responses bundled into the Worker, which has no folder to
 * read (PLAN-CLOUD.md, "Local dev and tests"). `ANALYSIS_REPLAY_DIR=dialogue`
 * replays this set, as `ANALYSIS_REPLAY_DIR=fixtures/dialogue/recorded` did on Node.
 */
export const BUNDLED_RECORDINGS: Record<string, Record<string, unknown>> = {
  dialogue: {
    'claude-annotate': claudeAnnotate,
    'claude-decisions': claudeDecisions,
    'claude-evaluate': claudeEvaluate,
    'claude-regenerate': claudeRegenerate,
    'claude-speakers': claudeSpeakers,
    elevenlabs,
    'gemini-regions': geminiRegions,
    gemini,
  },
};
