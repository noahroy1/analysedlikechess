import {
  NO_BEST_MOVE,
  MoveDraftSchema,
  projectFormat,
  relabelLateBook,
  type Format,
  type Moment,
  type Project,
  type RegenerateResult,
} from '@als/schema';
import type { AnalysisConfig } from './config.ts';
import { regenerateTask, systemPrompt } from './prompts.ts';
import type { Providers } from './providers/index.ts';
import type { StyleCorpus } from '@als/schema';
import { speakerName, timelineText } from './timeline-text.ts';

/**
 * Pass B for one moment, on the faster model: Regenerate, and drafting text
 * for "Make this a move". Returns a proposal; nothing is saved to the project,
 * so an open editor is never forced to reload. The caller logs the spend.
 */
export async function regenerateMoment(
  deps: { providers: Providers; config: AnalysisConfig; style: StyleCorpus },
  project: Project,
  moment: Moment,
  instruction?: string,
  format: Format = projectFormat(project),
): Promise<RegenerateResult> {
  const utterances = new Map((project.transcript?.utterances ?? []).map((u) => [u.id, u]));
  const evidence = moment.evidence.utteranceIds
    .map((id) => utterances.get(id))
    .filter((u) => u !== undefined)
    .map((u) => `[${u.start.toFixed(2)}] ${speakerName(project.context.characters, u.speaker)}: "${u.text}"`);
  const actor = project.context.characters.find((c) => c.id === moment.actorId)?.name;

  const result = await deps.providers.analyst.run({
    name: 'regenerate',
    model: deps.config.models.regen,
    effort: 'medium',
    interactive: true,
    system: systemPrompt(deps.style, format),
    context: timelineText(project),
    task: regenerateTask(moment, evidence, actor, instruction?.trim() || undefined),
    schema: MoveDraftSchema,
  });
  const classification = relabelLateBook(result.output.classification, moment.sourceTime, format);
  const draft = { ...result.output, classification, bestMove: NO_BEST_MOVE.has(classification) ? null : result.output.bestMove };
  return { draft, model: result.model, usage: result.usage, costUsd: result.costUsd };
}
