import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BoxSchema, FaceRegionSchema, regionsFresh, type FrameRegions, type Moment, type Project, type RegionsResult, type Theme } from '@als/schema';
import { moveNumbers } from '@als/composition/notation';
import { autoPlaceCard } from '@als/composition/placement';
import type { ProjectStore } from '../projects/store.ts';
import type { AnalysisConfig } from './config.ts';
import { REGIONS_PROMPT_VERSION, regionsPrompt } from './providers/gemini.ts';
import type { Providers, RegionContext } from './providers/index.ts';

// Faces and the move's subject on each frozen frame, so cards can be placed
// clear of them. Answers are cached per frame and prompt beside the project,
// so re-runs, undo and a retime back to the same frame cost nothing.

const CACHE = 'analysis/regions-cache.json';
const CacheSchema = z.record(
  z.string(),
  z.object({ faces: z.array(FaceRegionSchema), subject: BoxSchema.optional(), model: z.string() }),
);

/** Writes to a project's cache one at a time. */
const cacheLocks = new Map<string, Promise<unknown>>();

export interface RegionsDeps {
  store: ProjectStore;
  providers: Providers;
  config: AnalysisConfig;
}

/** The source frame a move freezes on, as the timeline counts it. */
export const freezeFrame = (project: Project, sourceTime: number) =>
  Math.min(Math.round(sourceTime * project.source.fps), Math.max(0, Math.round(project.source.durationSec * project.source.fps) - 1));

/** Faces and subject on a move's frozen frame: from the cache, or one call. */
export async function findRegions(deps: RegionsDeps, project: Project, moment: Moment): Promise<RegionsResult> {
  const { store, providers, config } = deps;
  const frame = freezeFrame(project, moment.sourceTime);
  const context: RegionContext = {
    moveLabel: moment.moveLabel,
    explanation: moment.explanation,
    actorName: project.context.characters.find((c) => c.id === moment.actorId)?.name,
  };
  const sourceHash = await readFile(store.file(project.id, 'ingest.json'), 'utf8').then((t) => JSON.parse(t).sourceHash as string);
  const key = createHash('sha256')
    .update(JSON.stringify([REGIONS_PROMPT_VERSION, config.models.regions, sourceHash, frame, regionsPrompt(context)]))
    .digest('hex');
  const stamp = (found: { faces: FrameRegions['faces']; subject?: FrameRegions['subject'] }): FrameRegions => ({
    sourceTime: moment.sourceTime,
    faces: found.faces,
    ...(found.subject ? { subject: found.subject } : {}),
  });

  const cached = (await readCache(store, project.id))[key];
  if (cached) return { regions: stamp(cached), model: cached.model, usage: {}, costUsd: 0 };

  const jpeg = await grabFrame(store.file(project.id, project.source.proxy), frame, project.source.fps);
  const found = await providers.regions.find(jpeg, context);
  await editCache(store, project.id, (cache) => {
    cache[key] = { faces: found.faces, ...(found.subject ? { subject: found.subject } : {}), model: found.model };
  });
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

/** One frame of the proxy (same frame numbers as the source) as a JPEG. */
async function grabFrame(proxyPath: string, frame: number, fps: number): Promise<Buffer> {
  // Just under the frame's time, so rounding never lands on the next one.
  const at = Math.max(0, (frame - 0.25) / fps);
  const { stdout } = await promisify(execFile)(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(4), '-i', proxyPath, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', '-'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  );
  if (!stdout.length) throw new Error(`no frame at ${at.toFixed(3)} s`);
  return stdout;
}

async function readCache(store: ProjectStore, id: string): Promise<z.infer<typeof CacheSchema>> {
  return readFile(store.file(id, CACHE), 'utf8').then(
    (t) => CacheSchema.parse(JSON.parse(t)),
    () => ({}),
  );
}

function editCache(store: ProjectStore, id: string, change: (cache: z.infer<typeof CacheSchema>) => void): Promise<void> {
  const next = (cacheLocks.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const cache = await readCache(store, id);
      change(cache);
      const path = store.file(id, CACHE);
      await mkdir(store.file(id, 'analysis'), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(cache));
      await rename(`${path}.tmp`, path);
    });
  cacheLocks.set(id, next);
  return next;
}

