import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BoxSchema, FaceRegionSchema, regionsFresh, type FrameRegions, type Moment, type Project, type RegionsResult, type Theme } from '@als/schema';
import { moveNumbers } from '@als/composition/notation';
import { autoPlaceCard } from '@als/composition/placement';
import { sourceHash as readSourceHash } from '../ingest/ingest.ts';
import type { MediaRunner, ProjectRepo } from '../ports.ts';
import type { AnalysisConfig } from './config.ts';
import { REGIONS_PROMPT_VERSION, regionsPrompt } from './providers/gemini.ts';
import type { Providers, RegionContext } from './providers/index.ts';

// Faces and the move's subject on each frozen frame, so cards can be placed
// clear of them. Answers are cached per frame and prompt with the project,
// so re-runs, undo and a retime back to the same frame cost nothing.

const CachedSchema = z.object({ faces: z.array(FaceRegionSchema), subject: BoxSchema.optional(), model: z.string() });

export interface RegionsDeps {
  repo: ProjectRepo;
  media: MediaRunner;
  providers: Providers;
  config: AnalysisConfig;
  /** Runs before a paid call (a frame not looked at yet); throws to refuse it. */
  check: () => Promise<void>;
}

/** The source frame a move freezes on, as the timeline counts it. */
export const freezeFrame = (project: Project, sourceTime: number) =>
  Math.min(Math.round(sourceTime * project.source.fps), Math.max(0, Math.round(project.source.durationSec * project.source.fps) - 1));

/** Faces and subject on a move's frozen frame: from the cache, or one call. */
export async function findRegions(deps: RegionsDeps, project: Project, moment: Moment): Promise<RegionsResult> {
  const { repo, media, providers, config } = deps;
  const frame = freezeFrame(project, moment.sourceTime);
  const context: RegionContext = {
    moveLabel: moment.moveLabel,
    explanation: moment.explanation,
    actorName: project.context.characters.find((c) => c.id === moment.actorId)?.name,
  };
  const sourceHash = await readSourceHash(repo, project.id);
  const key = createHash('sha256')
    .update(JSON.stringify([REGIONS_PROMPT_VERSION, config.models.regions, sourceHash, frame, regionsPrompt(context)]))
    .digest('hex');
  const stamp = (found: { faces: FrameRegions['faces']; subject?: FrameRegions['subject'] }): FrameRegions => ({
    sourceTime: moment.sourceTime,
    faces: found.faces,
    ...(found.subject ? { subject: found.subject } : {}),
  });

  const cached = CachedSchema.safeParse((await repo.getStage(project.id, 'regions', key))?.output);
  if (cached.success) return { regions: stamp(cached.data), model: cached.data.model, usage: {}, costUsd: 0 };

  await deps.check();
  const jpeg = await media.frame({ projectId: project.id, file: project.source.proxy, frame, fps: project.source.fps });
  const found = await providers.regions.find(jpeg, context);
  await repo.putStage(project.id, 'regions', key, key, { faces: found.faces, ...(found.subject ? { subject: found.subject } : {}), model: found.model });
  return { regions: stamp(found), model: found.model, usage: found.usage, costUsd: found.costUsd };
}

/**
 * Finds regions for every move whose card is placed automatically and places
 * it. Cards set by hand are left alone. Returns the moves and what it spent.
 */
export async function placeCards(
  deps: RegionsDeps,
  project: Project,
  theme: Theme,
): Promise<{ moments: Moment[]; costUsd: number; usage: { inputTokens: number; outputTokens: number }; model?: string; calls: number }> {
  const numbers = moveNumbers(project.moments, project.context.characters);
  const names = new Map(project.context.characters.map((c) => [c.id, c.name]));
  // Only cards meant to be placed: older cards keep their corner until the creator asks.
  const todo = project.moments.filter((m) => m.card.placement === 'auto');
  const results = new Map<string, RegionsResult>();
  // A few at a time: each call takes about 2 s.
  for (let i = 0; i < todo.length; i += 4) {
    const batch = todo.slice(i, i + 4);
    const found = await Promise.all(batch.map((m) => (regionsFresh(m) ? undefined : findRegions(deps, project, m))));
    batch.forEach((m, j) => found[j] && results.set(m.id, found[j]));
  }
  const frame = { width: project.source.width, height: project.source.height };
  const moments = project.moments.map((m) => {
    if (m.card.placement !== 'auto') return m;
    const regions = results.get(m.id)?.regions ?? m.regions;
    if (!regions) return m;
    const who = [numbers.get(m.id), m.actorId ? names.get(m.actorId) : undefined].filter(Boolean).join(' ');
    const placed = autoPlaceCard({ moment: { ...m, regions }, theme, frame, who, barScale: project.evalBarScale });
    return { ...m, regions, ...(placed ? { card: placed.card } : {}) };
  });
  const spent = [...results.values()];
  return {
    moments,
    costUsd: spent.reduce((sum, r) => sum + r.costUsd, 0),
    usage: {
      inputTokens: spent.reduce((sum, r) => sum + (r.usage.inputTokens ?? 0), 0),
      outputTokens: spent.reduce((sum, r) => sum + (r.usage.outputTokens ?? 0), 0),
    },
    ...(spent[0] ? { model: spent[0].model } : {}),
    calls: spent.filter((r) => r.costUsd > 0).length,
  };
}
