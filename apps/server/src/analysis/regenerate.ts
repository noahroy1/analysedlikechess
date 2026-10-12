import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { NO_BEST_MOVE, MoveDraftSchema, relabelLateBook, type Moment, type Project, type RegenerateResult } from '@als/schema';
import type { ProjectStore } from '../projects/store.ts';
import type { AnalysisConfig } from './config.ts';
import { regenerateTask, systemPrompt } from './prompts.ts';
import type { Providers } from './providers/index.ts';
import type { StyleCorpus } from '@als/schema';
import { speakerName, timelineText } from './timeline-text.ts';

/**
 * Pass B for one moment, on the faster model: Regenerate, and drafting text
 * for "Make this a move". Returns a proposal; nothing is saved to the project,
 * so an open editor is never forced to reload. Spend is logged beside it.
 */
export async function regenerateMoment(
  deps: { store: ProjectStore; providers: Providers; config: AnalysisConfig; style: StyleCorpus },
  project: Project,
  moment: Moment,
  instruction?: string,
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
    system: systemPrompt(deps.style),
    context: timelineText(project),
    task: regenerateTask(moment, evidence, actor, instruction?.trim() || undefined),
    schema: MoveDraftSchema,
  });
  const classification = relabelLateBook(result.output.classification, moment.sourceTime);
  const draft = { ...result.output, classification, bestMove: NO_BEST_MOVE.has(classification) ? null : result.output.bestMove };
  await logUsage(deps.store, project.id, 'regenerate', result.costUsd);
  return { draft, model: result.model, usage: result.usage, costUsd: result.costUsd };
}

/** Spend of the editor's own AI calls, which never write project.json: one log per kind beside the project. */
export interface EditorUsage {
  count: number;
  costUsd: number;
}

export type EditorCall = 'regenerate' | 'evaluate';

const usageFile = (store: ProjectStore, id: string, kind: EditorCall) => store.file(id, `analysis/${kind}-usage.json`);

export async function readUsage(store: ProjectStore, id: string, kind: EditorCall): Promise<EditorUsage> {
  return readFile(usageFile(store, id, kind), 'utf8')
    .then((t) => JSON.parse(t) as EditorUsage)
    .catch(() => ({ count: 0, costUsd: 0 }));
}

export async function logUsage(store: ProjectStore, id: string, kind: EditorCall, costUsd: number) {
  const usage = await readUsage(store, id, kind);
  await mkdir(store.file(id, 'analysis'), { recursive: true });
  await writeFile(
    usageFile(store, id, kind),
    JSON.stringify({ count: usage.count + 1, costUsd: Math.round((usage.costUsd + costUsd) * 1e6) / 1e6 }),
  );
}
