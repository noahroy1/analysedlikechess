import {
  BEAT_CLEARANCE_SEC,
  BEAT_MAX_SWING,
  DEFAULT_START_EVAL,
  capBeat,
  evalFill,
  isMate,
  pawnsForFill,
  sameEval,
  swingFits,
  toEval,
  type Candidate,
  type Character,
  type Eval,
  type EvalBar,
  type EvalBeat,
  type Evaluation,
  type Moment,
  type Project,
} from '@als/schema';
import type { EvaluationItem } from './prompts.ts';
import { characterByName } from './sides.ts';
import { candidateTime } from './snap-moves.ts';

/**
 * Beats: the decisions Pass A found that Pass B did not give a card. The bar
 * moves at each, so it reacts between cards. Beats the creator added stay; a
 * beat too close to a card or another beat (still settling) is dropped.
 */
export function placeBeats(project: Project, candidates: readonly Candidate[], picked: ReadonlySet<string>): EvalBeat[] {
  const kept = (project.evalBar?.beats ?? []).filter((b) => b.origin === 'user');
  const taken = [...project.moments.map((m) => m.sourceTime), ...kept.map((b) => b.sourceTime)];
  const clear = (t: number) => taken.every((other) => Math.abs(other - t) >= BEAT_CLEARANCE_SEC);
  const placed: EvalBeat[] = [];
  for (const candidate of candidates) {
    if (picked.has(candidate.id)) continue;
    const sourceTime = candidateTime(project, candidate);
    if (sourceTime === undefined || !clear(sourceTime)) continue;
    taken.push(sourceTime);
    const actorId = characterByName(project.context.characters, candidate.actor)?.id;
    placed.push({
      id: `beat-${candidate.id}`,
      sourceTime,
      // A placeholder until Pass C answers; never saved without one.
      eval: DEFAULT_START_EVAL,
      ...(actorId ? { actorId } : {}),
      action: candidate.action,
      origin: 'ai',
    });
  }
  return [...kept, ...placed].sort((a, b) => a.sourceTime - b.sourceTime);
}

export interface EvalTrack {
  moments: Moment[];
  characters: Character[];
  evalBar: EvalBar;
}

/** What Pass C reads: every card and beat in order, with who moved and on which side. */
export function evaluationItems(track: EvalTrack, fixed: ReadonlySet<string> = new Set()): EvaluationItem[] {
  const byId = new Map(track.characters.map((c) => [c.id, c]));
  const who = (actorId: string | undefined) => {
    const c = actorId ? byId.get(actorId) : undefined;
    return { ...(c ? { actor: c.name } : {}), ...(c?.side ? { side: c.side } : {}) };
  };
  const cards: EvaluationItem[] = track.moments.map((m) => ({
    id: m.id,
    kind: 'card',
    sourceTime: m.sourceTime,
    ...who(m.actorId),
    classification: m.classification,
    moveLabel: m.moveLabel,
    explanation: m.explanation,
    ...(fixed.has(m.id) && m.eval ? { fixed: m.eval } : {}),
  }));
  const beats: EvaluationItem[] = track.evalBar.beats.map((b) => ({
    id: b.id,
    kind: 'beat',
    sourceTime: b.sourceTime,
    ...who(b.actorId),
    ...(b.action ? { action: b.action } : {}),
    ...(fixed.has(b.id) ? { fixed: b.eval } : {}),
  }));
  return [...beats, ...cards].sort((a, b) => a.sourceTime - b.sourceTime || (a.kind === b.kind ? 0 : a.kind === 'beat' ? -1 : 1));
}

export interface AppliedEvaluation extends EvalTrack {
  /** Ids whose value was changed to fit the rules, with why. */
  adjusted: { id: string; reason: string }[];
}

/**
 * Writes Pass C's answer into the track, then holds it to the rules the bar
 * keeps whatever the model says: a rating never moves the bar the wrong way
 * for the player who made it (such a move holds steady instead), beats move it
 * at most BEAT_MAX_SWING and never start a mate. Fixed values are kept as they are.
 */
export function applyEvaluation(
  track: EvalTrack,
  output: Evaluation,
  fixed: ReadonlySet<string> = new Set(),
  fixedStart = false,
): AppliedEvaluation {
  const answers = new Map(output.evals.map((e) => [e.id, e]));
  const sides = new Map(track.characters.map((c) => [c.id, c.side]));
  const adjusted: AppliedEvaluation['adjusted'] = [];
  const start = fixedStart ? track.evalBar.start : toEval(output.start);

  const moments = track.moments.map((m) => {
    const answer = answers.get(m.id);
    return fixed.has(m.id) || !answer ? { ...m } : { ...m, eval: toEval(answer) };
  });
  const beats = track.evalBar.beats.map((b) => {
    const answer = answers.get(b.id);
    if (fixed.has(b.id) || !answer) return { ...b };
    return { ...b, eval: toEval(answer), ...(answer.reason.trim() ? { reason: answer.reason.trim() } : {}) };
  });

  // Walk the bar in order, each change measured from the value before it.
  // `moments` and `beats` are fresh copies, so adjusting them in place is safe.
  type Entry = { kind: 'move'; m: Moment } | { kind: 'beat'; b: EvalBeat };
  const entries: Entry[] = [
    ...beats.map((b): Entry => ({ kind: 'beat', b })),
    ...moments.map((m): Entry => ({ kind: 'move', m })),
  ].sort((x, y) => {
    const tx = x.kind === 'move' ? x.m.sourceTime : x.b.sourceTime;
    const ty = y.kind === 'move' ? y.m.sourceTime : y.b.sourceTime;
    return tx - ty || (x.kind === y.kind ? 0 : x.kind === 'beat' ? -1 : 1);
  });
  let before: Eval = start;
  for (const entry of entries) {
    if (entry.kind === 'move') {
      const { m } = entry;
      if (!m.eval) continue;
      const side = m.actorId ? sides.get(m.actorId) : undefined;
      if (!fixed.has(m.id) && side && !swingFits(m.classification, side, before, m.eval)) {
        adjusted.push({ id: m.id, reason: `${m.classification} moved the bar the wrong way for ${side}; it holds instead` });
        m.eval = before;
      }
      before = m.eval;
    } else {
      const { b } = entry;
      if (!fixed.has(b.id)) {
        let next = capBeat(before, b.eval);
        const startsMate = isMate(next) && !(isMate(before) && Math.sign(before.mate) === Math.sign(next.mate));
        if (startsMate) {
          const from = evalFill(before);
          next = pawnsForFill(Math.min(Math.max(evalFill(next), from - BEAT_MAX_SWING), from + BEAT_MAX_SWING));
        }
        if (!sameEval(next, b.eval)) adjusted.push({ id: b.id, reason: startsMate ? 'a beat cannot start a mate' : 'capped to a beat-sized swing' });
        b.eval = next;
      }
      before = b.eval;
    }
  }
  return { moments, characters: track.characters, evalBar: { start, beats }, adjusted };
}
