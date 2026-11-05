import {
  DEFAULT_START_EVAL,
  evaluationSchema,
  type Annotation,
  type DecisionPoints,
  projectFormat,
  type EvalBeat,
  type EvaluateRequest,
  type EvaluateResult,
  type Project,
  type StyleCorpus,
} from '@als/schema';
import type { ProjectRepo } from '../ports.ts';
import type { AnalysisConfig } from './config.ts';
import { applyEvaluation, evaluationItems, placeBeats } from './evaluate.ts';
import { evaluationTask, systemPrompt } from './prompts.ts';
import type { Providers } from './providers/index.ts';
import { timelineText } from './timeline-text.ts';

/**
 * Pass C alone, for the editor's Re-evaluate: values the bar for the track as
 * it stands in the editor. Returns a proposal; nothing is saved to the
 * project, so an open editor is never forced to reload. The caller logs the spend.
 */
export async function reevaluate(
  deps: { repo: ProjectRepo; providers: Providers; config: AnalysisConfig; style: StyleCorpus },
  project: Project,
  request: EvaluateRequest,
): Promise<EvaluateResult> {
  const current: Project = {
    ...project,
    moments: request.moments,
    context: { ...project.context, characters: request.characters },
    ...(request.format ? { format: request.format } : {}),
  };
  const format = projectFormat(current);
  const track = {
    moments: request.moments,
    characters: request.characters,
    evalBar: request.evalBar ?? { start: DEFAULT_START_EVAL, beats: await beatsFromLastAnalysis(deps.repo, current) },
  };
  const items = evaluationItems(track);
  const schema = evaluationSchema(items.map((i) => i.id));
  const result = await deps.providers.analyst.run({
    name: 'evaluate',
    model: deps.config.models.analyst,
    effort: 'medium',
    interactive: true,
    system: systemPrompt(deps.style, format),
    context: timelineText(current),
    task: evaluationTask(items, format),
    schema,
  });
  const applied = applyEvaluation(track, result.output, format);
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
async function beatsFromLastAnalysis(repo: ProjectRepo, project: Project): Promise<EvalBeat[]> {
  const [decisionsEntry, annotationEntry] = await Promise.all([
    repo.getStage(project.id, 'analysis', 'decisions'),
    repo.getStage(project.id, 'analysis', 'annotate'),
  ]);
  // Written by this app's own pipeline after validation against the clip's schema.
  const decisions = decisionsEntry?.output as DecisionPoints | undefined;
  const annotation = annotationEntry?.output as Annotation | undefined;
  if (!decisions) return [];
  return placeBeats(project, decisions.candidates, new Set(annotation?.moves.map((m) => m.candidateId) ?? []));
}
