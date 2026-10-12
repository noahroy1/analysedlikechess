import { readFile } from 'node:fs/promises';
import {
  DEFAULT_START_EVAL,
  evaluationSchema,
  type Annotation,
  type DecisionPoints,
  type EvalBeat,
  type EvaluateRequest,
  type EvaluateResult,
  type Project,
  type StyleCorpus,
} from '@als/schema';
import type { ProjectStore } from '../projects/store.ts';
import type { AnalysisConfig } from './config.ts';
import { applyEvaluation, evaluationItems, placeBeats } from './evaluate.ts';
import { evaluationTask, systemPrompt } from './prompts.ts';
import type { Providers } from './providers/index.ts';
import { logUsage } from './regenerate.ts';
import { timelineText } from './timeline-text.ts';

/**
 * Pass C alone, for the editor's Re-evaluate: values the bar for the track as
 * it stands in the editor. Returns a proposal; nothing is saved to the
 * project, so an open editor is never forced to reload. Spend is logged beside it.
 */
export async function reevaluate(
  deps: { store: ProjectStore; providers: Providers; config: AnalysisConfig; style: StyleCorpus },
  project: Project,
  request: EvaluateRequest,
): Promise<EvaluateResult> {
  const current: Project = { ...project, moments: request.moments, context: { ...project.context, characters: request.characters } };
  const track = {
    moments: request.moments,
    characters: request.characters,
    evalBar: request.evalBar ?? { start: DEFAULT_START_EVAL, beats: await beatsFromLastAnalysis(deps.store, current) },
  };
  const items = evaluationItems(track);
  const schema = evaluationSchema(items.map((i) => i.id));
  const result = await deps.providers.analyst.run({
    name: 'evaluate',
    model: deps.config.models.analyst,
    effort: 'medium',
    system: systemPrompt(deps.style),
    context: timelineText(current),
    task: evaluationTask(items),
    schema,
  });
  const applied = applyEvaluation(track, result.output);
  await logUsage(deps.store, project.id, 'evaluate', result.costUsd);
  return {
    evalBar: applied.evalBar,
    evals: Object.fromEntries(applied.moments.flatMap((m) => (m.eval ? [[m.id, m.eval]] : []))),
    adjusted: applied.adjusted,
    model: result.model,
    usage: result.usage,
    costUsd: result.costUsd,
  };
}

/** A project analysed before the bar existed has no beats yet: place them from its cached Pass A and B. */
async function beatsFromLastAnalysis(store: ProjectStore, project: Project): Promise<EvalBeat[]> {
  const read = <T>(name: string) =>
    readFile(store.file(project.id, `analysis/${name}.json`), 'utf8').then(
      (t) => JSON.parse(t) as T,
      () => undefined,
    );
  const [decisions, annotation] = await Promise.all([read<DecisionPoints>('decisions'), read<Annotation>('annotate')]);
  if (!decisions) return [];
  return placeBeats(project, decisions.candidates, new Set(annotation?.moves.map((m) => m.candidateId) ?? []));
}
