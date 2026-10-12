import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_START_EVAL,
  SceneNoteSchema,
  TranscriptSchema,
  annotationSchema,
  decisionPointsSchema,
  evaluationSchema,
  speakerNamingSchema,
  type Analysis,
  type Annotation,
  type Character,
  type DecisionPoints,
  type Project,
  type Stage,
  type StyleCorpus,
  type Usage,
} from '@als/schema';
import { getTheme } from '@als/theme/themes';
import type { ProjectStore } from '../projects/store.ts';
import type { AnalysisConfig } from './config.ts';
import { applyEvaluation, evaluationItems, placeBeats } from './evaluate.ts';
import { annotationTask, decisionPointsTask, evaluationTask, speakerNamingTask, systemPrompt, targetMoveCount } from './prompts.ts';
import type { Providers } from './providers/index.ts';
import { assignSides } from './sides.ts';
import { snapMoves } from './snap-moves.ts';
import { castNames, timelineText } from './timeline-text.ts';

export const ANALYSIS_STAGES = ['transcribe', 'describe', 'speakers', 'decisions', 'annotate', 'snap', 'evaluate'] as const;
type StageName = (typeof ANALYSIS_STAGES)[number];

/** Bump a step's version when its prompt or parsing changes, so cached outputs are redone. */
const STEP_VERSION: Record<Exclude<StageName, 'snap'>, number> = {
  transcribe: 1,
  describe: 1,
  speakers: 1,
  decisions: 1,
  annotate: 2,
  evaluate: 1,
};

const NAMING_SYSTEM =
  'You identify who is speaking in film scenes from transcripts and scene notes. Answer only with the requested JSON.';

export interface AnalysisDeps {
  store: ProjectStore;
  providers: Providers;
  config: AnalysisConfig;
  style: StyleCorpus;
}

export interface AnalysisOptions {
  /** 'analyst' redoes Passes A, B and C with the cached transcript and scene notes; 'all' redoes everything. */
  rerun?: 'analyst' | 'all';
}

export const pendingAnalysis = (previous: Analysis): Analysis => ({
  status: 'pending',
  stages: ANALYSIS_STAGES.map((name) => ({ name, status: 'pending' })),
  models: previous.models,
  secondsPerMove: previous.secondsPerMove,
});

const ManifestSchema = z.object({
  keys: z.partialRecord(z.enum(ANALYSIS_STAGES), z.string()),
  /**
   * Character names given to perception as spelling and identity hints, captured
   * on its first run. Speaker naming adds names later; reusing the captured hints
   * keeps re-runs of the Analyst from redoing transcription and scene notes.
   */
  perceptionHints: z.array(z.string()).optional(),
});
const cacheKey = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

interface StepResult<T> {
  value: T;
  model?: string;
  usage?: Usage;
  costUsd?: number;
}

/**
 * Stages 2-5 of the pipeline: transcribe and describe (in parallel), name the
 * speakers, find decision points (Pass A), annotate (Pass B), snap to frames,
 * then evaluate the bar (Pass C). Every step is skipped when its inputs are unchanged.
 */
export async function runAnalysis(
  deps: AnalysisDeps,
  id: string,
  options: AnalysisOptions,
  onUpdate: (analysis: Analysis) => void,
): Promise<Analysis> {
  const { store, providers, config, style } = deps;
  const dir = store.file(id, 'analysis');
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = await readFile(manifestPath, 'utf8')
    .then((t) => ManifestSchema.parse(JSON.parse(t)))
    .catch(() => ({ keys: {} }) as z.infer<typeof ManifestSchema>);

  let project = await store.read(id);
  const analysis: Analysis = { ...pendingAnalysis(project.analysis), status: 'running', models: {} };
  const stageOf = (name: StageName) => analysis.stages.find((s) => s.name === name)!;
  const emit = () => {
    analysis.costUsd = totalCost(analysis);
    onUpdate(analysis);
  };
  // Persisted only at checkpoints; live progress goes over SSE, so an editor
  // that is open meanwhile is not forced to reload at every stage.
  const persist = async (change?: (p: Project) => void, snapshot = false) => {
    project = await store.update(
      id,
      (p) => {
        change?.(p);
        analysis.costUsd = totalCost(analysis);
        p.analysis = structuredClone(analysis);
      },
      { snapshot },
    );
  };
  emit();

  const force = (name: StageName) =>
    options.rerun === 'all' || (options.rerun === 'analyst' && (name === 'decisions' || name === 'annotate' || name === 'evaluate'));

  /** Runs one step unless its key matches the last run and its output is on disk. */
  async function step<T>(name: StageName, key: string, schema: z.ZodType<T>, work: () => Promise<StepResult<T>>): Promise<T> {
    const stage: Stage = stageOf(name);
    const file = join(dir, `${name}.json`);
    if (!force(name) && manifest.keys[name] === key) {
      const cached = await readFile(file, 'utf8').then((t) => schema.safeParse(JSON.parse(t)), () => undefined);
      if (cached?.success) {
        stage.status = 'cached';
        emit();
        return cached.data;
      }
    }
    stage.status = 'running';
    emit();
    const started = performance.now();
    const result = await work();
    await writeFile(`${file}.tmp`, `${JSON.stringify(result.value, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
    manifest.keys[name] = key;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    Object.assign(stage, {
      status: 'done',
      durationMs: Math.round(performance.now() - started),
      ...(result.model ? { model: result.model } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.costUsd !== undefined ? { costUsd: round6(result.costUsd) } : {}),
    });
    if (result.model) analysis.models[name] = result.model;
    emit();
    return result.value;
  }

  const skip = (name: StageName) => {
    stageOf(name).status = 'skipped';
    emit();
  };

  try {
    if (project.ingest.status !== 'done') throw new Error('Ingest has not finished');
    const sourceHash = await readFile(store.file(id, 'ingest.json'), 'utf8').then((t) => JSON.parse(t).sourceHash as string);
    const { durationSec, hasAudio } = project.source;
    const typedNames = project.context.characters.map((c) => c.name).filter(Boolean);
    if (options.rerun === 'all' || !manifest.perceptionHints) manifest.perceptionHints = typedNames;
    const hints = manifest.perceptionHints;
    const audioPath = store.file(id, 'audio.wav');

    // Stage 2: perception, in parallel.
    // Both run to completion even if one fails, so the other's paid result is cached for the retry.
    const transcribing =
      hasAudio && (await exists(audioPath))
        ? step(
            'transcribe',
            cacheKey('transcribe', STEP_VERSION.transcribe, sourceHash, config.models.transcriber, hints),
            TranscriptSchema,
            async () => {
              const r = await providers.transcriber.transcribe(audioPath, { keyterms: hints, durationSec });
              return { value: r.transcript, model: r.model, usage: r.usage, costUsd: r.costUsd };
            },
          )
        : (skip('transcribe'), undefined);
    const describing = step(
        'describe',
        cacheKey('describe', STEP_VERSION.describe, sourceHash, config.models.scene, config.sceneFps, project.context.movieTitle, project.context.sceneNote, hints),
        z.array(SceneNoteSchema),
        async () => {
          const r = await providers.describer.describe(store.file(id, project.source.proxy), {
            durationSec,
            context: { movieTitle: project.context.movieTitle, sceneNote: project.context.sceneNote, characterNames: hints },
          });
          return { value: r.notes, model: r.model, usage: r.usage, costUsd: r.costUsd };
        },
      );
    const failed = (await Promise.allSettled([transcribing, describing])).find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const [transcript, sceneNotes] = await Promise.all([transcribing, describing]);
    await persist((p) => {
      if (transcript) p.transcript = transcript;
      p.sceneNotes = sceneNotes;
      dropMissingEvidence(p);
    });

    // Speaker naming: only labels the creator has not already assigned.
    const labels = [...new Set(project.transcript?.utterances.map((u) => u.speaker) ?? [])];
    const unassigned = labels.filter((l) => !project.context.characters.some((c) => c.speakerLabels.includes(l)));
    if (unassigned.length === 0) {
      skip('speakers');
    } else {
      const samples = unassigned
        .map((label) => {
          const lines = (project.transcript?.utterances ?? []).filter((u) => u.speaker === label).slice(0, 6);
          return `Speaker ${label}:\n${lines.map((u) => `  [${u.start.toFixed(1)}] ${u.text}`).join('\n')}`;
        })
        .join('\n');
      const schema = speakerNamingSchema(unassigned);
      const naming = await step(
        'speakers',
        cacheKey('speakers', STEP_VERSION.speakers, config.models.naming, samples, project.sceneNotes, typedNames, project.context.movieTitle),
        schema,
        async () => {
          const r = await providers.analyst.run({
            name: 'speakers',
            model: config.models.naming,
            effort: 'low',
            system: NAMING_SYSTEM,
            context: timelineText(project),
            task: speakerNamingTask(samples, typedNames),
            schema,
          });
          return { value: r.output, model: r.model, usage: r.usage, costUsd: r.costUsd };
        },
      );
      await persist((p) => {
        p.context.characters = assignSpeakers(p.context.characters, naming.speakers, unassigned);
      });
    }

    // Stage 3: the Analyst.
    const context = timelineText(project);
    const system = systemPrompt(style);
    const cast = castNames(project);
    const utteranceIds = project.transcript?.utterances.map((u) => u.id) ?? [];
    const target = targetMoveCount(durationSec, analysis.secondsPerMove);

    const passASchema = decisionPointsSchema(cast, utteranceIds);
    const passA: DecisionPoints = await step(
      'decisions',
      cacheKey('decisions', STEP_VERSION.decisions, config.models.analyst, system, context, target),
      passASchema,
      async () => {
        const r = await providers.analyst.run({
          name: 'decisions',
          model: config.models.analyst,
          effort: 'medium',
          system,
          context,
          task: decisionPointsTask(target),
          schema: passASchema,
        });
        return { value: r.output, model: r.model, usage: r.usage, costUsd: r.costUsd };
      },
    );
    const candidates = uniqueIds(passA.candidates);

    const passBSchema = annotationSchema(candidates.map((c) => c.id), cast);
    const passB: Annotation = await step(
      'annotate',
      cacheKey('annotate', STEP_VERSION.annotate, config.models.analyst, system, context, candidates, target),
      passBSchema,
      async () => {
        const r = await providers.analyst.run({
          name: 'annotate',
          model: config.models.analyst,
          effort: 'high',
          system,
          context,
          task: annotationTask(candidates, target),
          schema: passBSchema,
        });
        return { value: r.output, model: r.model, usage: r.usage, costUsd: r.costUsd };
      },
    );

    // Stage 4: snap to frames and merge. History keeps the track this replaces.
    const snapStage = stageOf('snap');
    snapStage.status = 'running';
    emit();
    const snapped = snapMoves(project, candidates, passB.moves, getTheme(project.themeId));
    snapStage.status = 'done';
    await persist((p) => {
      p.moments = snapped.moments;
      p.context.characters = assignSides(p.context.characters, p.moments, passB.protagonist);
    }, true);
    if (snapped.dropped.length) console.log(`analysis ${id}: dropped`, snapped.dropped);

    // Stage 5: the evaluation bar (Pass C). One call values every card and
    // beat together, so the bar tells one story instead of wobbling. Evals the
    // creator kept (on approved or own moves, and their own beats) stay fixed.
    const fixed = new Set([
      ...project.moments.filter((m) => m.eval && (m.origin === 'user' || m.status === 'approved')).map((m) => m.id),
      ...(project.evalBar?.beats ?? []).filter((b) => b.origin === 'user').map((b) => b.id),
    ]);
    const track = {
      moments: project.moments,
      characters: project.context.characters,
      evalBar: {
        start: project.evalBar?.start ?? DEFAULT_START_EVAL,
        beats: placeBeats(project, candidates, new Set(passB.moves.map((m) => m.candidateId))),
      },
    };
    const items = evaluationItems(track, fixed);
    const passCSchema = evaluationSchema(items.map((i) => i.id));
    const passC = await step(
      'evaluate',
      cacheKey('evaluate', STEP_VERSION.evaluate, config.models.analyst, system, context, items),
      passCSchema,
      async () => {
        const r = await providers.analyst.run({
          name: 'evaluate',
          model: config.models.analyst,
          effort: 'medium',
          system,
          context,
          task: evaluationTask(items),
          schema: passCSchema,
        });
        return { value: r.output, model: r.model, usage: r.usage, costUsd: r.costUsd };
      },
    );
    const applied = applyEvaluation(track, passC, fixed);
    analysis.status = 'done';
    await persist((p) => {
      p.moments = applied.moments;
      p.evalBar = applied.evalBar;
    });
    if (applied.adjusted.length) console.log(`analysis ${id}: evals adjusted`, applied.adjusted);
  } catch (error) {
    const running = analysis.stages.filter((s) => s.status === 'running');
    const message = error instanceof Error ? error.message : String(error);
    for (const stage of running) {
      stage.status = 'error';
      stage.error = message;
    }
    analysis.status = 'error';
    analysis.error = message;
    await persist().catch(() => undefined);
  }
  emit();
  return analysis;
}

/** Spend of this run: stages that did work (cached ones cost nothing). */
function totalCost(analysis: Analysis): number {
  return round6(analysis.stages.reduce((sum, s) => sum + (s.status === 'done' ? (s.costUsd ?? 0) : 0), 0));
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Gives each unassigned label to the named character, creating characters as needed. */
export function assignSpeakers(
  characters: Character[],
  named: { label: string; name: string }[],
  unassigned: string[],
): Character[] {
  const next = structuredClone(characters);
  for (const { label, name } of named) {
    if (!unassigned.includes(label) || next.some((c) => c.speakerLabels.includes(label))) continue;
    const clean = name.trim() || `Speaker ${label}`;
    const existing = next.find((c) => c.name.trim().toLowerCase() === clean.toLowerCase());
    if (existing) existing.speakerLabels.push(label);
    else next.push({ id: `c-${slug(clean)}-${label.toLowerCase()}`, name: clean, speakerLabels: [label] });
  }
  return next;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'character';

/** Candidate ids must be unique for Pass B to refer to them. */
function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.map((item, i) => {
    const id = seen.has(item.id) ? `${item.id}-${i + 1}` : item.id;
    seen.add(id);
    return { ...item, id };
  });
}

/** A new transcript has new utterance ids; kept moments may only cite ones that exist. */
function dropMissingEvidence(project: Project) {
  const ids = new Set(project.transcript?.utterances.map((u) => u.id) ?? []);
  for (const m of project.moments) m.evidence.utteranceIds = m.evidence.utteranceIds.filter((u) => ids.has(u));
}
