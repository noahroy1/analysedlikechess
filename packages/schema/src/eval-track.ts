import type { Classification } from './classification.ts';
import {
  BEAT_CLEARANCE_SEC,
  BEAT_MAX_SWING,
  DEFAULT_START_EVAL,
  evalFill,
  swingFits,
  type Eval,
  type EvalBar,
} from './eval.ts';
import type { Character, Moment } from './project.ts';

/** One change of the bar: a move's eval at its freeze, or a beat's during play. */
export interface EvalKeyframe {
  id: string;
  kind: 'move' | 'beat';
  sourceTime: number;
  eval: Eval;
  /** The eval it moves from. */
  before: Eval;
  side?: 'white' | 'black';
  classification?: Classification;
}

/**
 * Every change of the bar in order. Moves without an eval are skipped, so the
 * bar holds through them. At the same time a beat comes before the move.
 */
export function evalKeyframes(
  evalBar: EvalBar | undefined,
  moments: readonly Pick<Moment, 'id' | 'sourceTime' | 'eval' | 'actorId' | 'classification'>[],
  characters: readonly Pick<Character, 'id' | 'side'>[],
): EvalKeyframe[] {
  const sides = new Map(characters.map((c) => [c.id, c.side]));
  const items = [
    ...(evalBar?.beats ?? []).map((b) => ({ id: b.id, kind: 'beat' as const, sourceTime: b.sourceTime, eval: b.eval, side: b.actorId ? sides.get(b.actorId) : undefined })),
    ...moments.flatMap((m) =>
      m.eval
        ? [{ id: m.id, kind: 'move' as const, sourceTime: m.sourceTime, eval: m.eval, side: m.actorId ? sides.get(m.actorId) : undefined, classification: m.classification }]
        : [],
    ),
  ].sort((a, b) => a.sourceTime - b.sourceTime || (a.kind === b.kind ? 0 : a.kind === 'beat' ? -1 : 1));

  let before = evalBar?.start ?? DEFAULT_START_EVAL;
  return items.map(({ side, ...item }) => {
    const keyframe: EvalKeyframe = { ...item, before, ...(side ? { side } : {}) };
    before = item.eval;
    return keyframe;
  });
}

/**
 * Soft rules for the bar, by move or beat id: the editor shows them but still
 * saves. A move whose eval goes against its rating, a beat that swings more
 * than a beat should, and a beat too close to another change of the bar.
 */
export function evalWarnings(
  evalBar: EvalBar | undefined,
  moments: readonly Moment[],
  characters: readonly Character[],
): Map<string, string[]> {
  const warnings = new Map<string, string[]>();
  if (!evalBar) return warnings;
  const add = (id: string, message: string) => warnings.set(id, [...(warnings.get(id) ?? []), message]);
  const names = new Map(characters.map((c) => [c.id, c.name]));
  const keyframes = evalKeyframes(evalBar, moments, characters);

  for (const m of moments) if (!m.eval) add(m.id, 'No eval: the bar holds through this move');
  keyframes.forEach((k, i) => {
    if (k.kind === 'move' && k.side && k.classification && !swingFits(k.classification, k.side, k.before, k.eval)) {
      const actor = moments.find((m) => m.id === k.id)?.actorId;
      const who = (actor && names.get(actor)) || k.side;
      const way = evalFill(k.eval) > evalFill(k.before) === (k.side === 'white') ? 'rises' : 'falls';
      add(k.id, `The bar ${way} for ${who} on a ${k.classification}`);
    }
    if (k.kind === 'beat') {
      const swing = Math.abs(evalFill(k.eval) - evalFill(k.before));
      if (swing > BEAT_MAX_SWING + 1e-9) {
        add(k.id, `Moves the bar ${Math.round(swing * 100)}%; beats stay under ${Math.round(BEAT_MAX_SWING * 100)}% so big swings get a card`);
      }
      const near = [keyframes[i - 1], keyframes[i + 1]].find((o) => o && Math.abs(o.sourceTime - k.sourceTime) < BEAT_CLEARANCE_SEC);
      if (near) add(k.id, `Within ${BEAT_CLEARANCE_SEC} s of another change of the bar`);
    }
  });
  return warnings;
}
