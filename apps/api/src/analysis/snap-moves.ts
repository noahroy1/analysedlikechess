import {
  FORMAT_RULES,
  MIN_MOMENT_GAP_SEC,
  NO_BEST_MOVE,
  autoHoldSec,
  relabelLateBook,
  cleanFreezeTime,
  freezeAfterSpeech,
  projectFormat,
  type Annotation,
  type Candidate,
  type Moment,
  type Project,
  type Theme,
  type Word,
} from '@als/schema';
import { characterByName } from './sides.ts';

export interface SnapResult {
  moments: Moment[];
  /** Moves that could not be placed, with why. */
  dropped: { candidateId: string; reason: string }[];
}

const spoken = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * When the words the Analyst quoted end within their utterance: the first
 * place they are said, so a move freezes before its line goes on. Undefined
 * when they are not said there word for word (punctuation and case aside).
 */
export function quoteEnd(words: readonly Word[], wordRange: readonly [number, number], quote: string): number | undefined {
  const want = quote.split(/\s+/).map(spoken).filter(Boolean);
  if (!want.length) return undefined;
  const said = words.slice(wordRange[0], wordRange[1] + 1);
  const heard = said.map((w) => spoken(w.text));
  for (let end = want.length - 1; end < heard.length; end++) {
    if (want.every((w, i) => heard[end - want.length + 1 + i] === w)) return said[end]!.end;
  }
  return undefined;
}

/**
 * When a candidate's move happens: a spoken move just after the words it is
 * made in (`moveLine`), before anyone answers, in that word's shot; a visual
 * move on the nearest clean frame. Candidates from before `moveLine` freeze
 * after their last evidence utterance. Undefined when there is neither
 * evidence nor a time.
 */
export function candidateTime(project: Project, candidate: Candidate): number | undefined {
  const { fps, durationSec } = project.source;
  const shots = project.shots ?? [];
  const words = project.transcript?.words ?? [];
  const utterances = new Map((project.transcript?.utterances ?? []).map((u) => [u.id, u]));
  const line = candidate.moveLine ? utterances.get(candidate.moveLine.utteranceId) : undefined;
  if (line && candidate.kind === 'spoken') {
    const end = quoteEnd(words, line.wordRange, candidate.moveLine!.lastWords) ?? words[line.wordRange[1]]?.end ?? line.end;
    return Math.min(freezeAfterSpeech(end, shots, fps), durationSec);
  }
  const evidence = candidate.evidenceUtteranceIds.map((id) => utterances.get(id)).filter((u) => u !== undefined);
  if ((candidate.kind === 'spoken' || candidate.visualTimeSec === null) && evidence.length) {
    const last = evidence.reduce((a, b) => (b.end > a.end ? b : a));
    const lastWordEnd = words[last.wordRange[1]]?.end ?? last.end;
    return Math.min(freezeAfterSpeech(lastWordEnd, shots, fps), durationSec);
  }
  if (candidate.visualTimeSec !== null) {
    return Math.min(cleanFreezeTime(Math.min(Math.max(candidate.visualTimeSec, 0), durationSec), shots, fps), durationSec);
  }
  return undefined;
}

/**
 * Stage 4: places each annotated move on an exact frame and merges the drafts
 * into the track. Spoken moves freeze just after their last word, in that
 * word's shot; visual moves on the nearest clean frame; none before the
 * format's `firstCardFloorSec`. Moves the creator
 * approved or added are kept; AI drafts are replaced.
 */
export function snapMoves(project: Project, candidates: Candidate[], moves: Annotation['moves'], theme: Theme): SnapResult {
  const utterances = new Map((project.transcript?.utterances ?? []).map((u) => [u.id, u]));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const dropped: SnapResult['dropped'] = [];

  const characterFor = (name: string) => characterByName(project.context.characters, name)?.id;
  const format = projectFormat(project);
  const { firstCardFloorSec } = FORMAT_RULES[format];
  const { fps } = project.source;
  // The first clean frame from the floor on: a move said earlier waits for it.
  const floor = firstCardFloorSec > 0 ? Math.max(firstCardFloorSec, cleanFreezeTime(firstCardFloorSec, project.shots ?? [], fps)) : 0;

  const placed: Moment[] = [];
  moves.forEach((move, index) => {
    const candidate = byId.get(move.candidateId);
    if (!candidate) return dropped.push({ candidateId: move.candidateId, reason: 'unknown candidate' });
    const evidence = candidate.evidenceUtteranceIds.map((id) => utterances.get(id)).filter((u) => u !== undefined);
    const time = candidateTime(project, candidate);
    if (time === undefined) return dropped.push({ candidateId: candidate.id, reason: 'no evidence or time to place it' });
    const sourceTime = Math.max(time, floor);

    const actorId = characterFor(candidate.actor);
    const classification = relabelLateBook(move.classification, sourceTime, format);
    const bestMove = NO_BEST_MOVE.has(classification) ? undefined : move.bestMove?.trim() || undefined;
    const motif = move.motif?.trim() || undefined;
    const text = {
      moveLabel: move.moveLabel.trim(),
      explanation: move.explanation.trim(),
      ...(bestMove ? { bestMove } : {}),
      ...(motif ? { motif } : {}),
    };
    placed.push({
      id: `ai-${candidate.id}-${index + 1}`,
      sourceTime,
      holdSec: autoHoldSec(text, theme.timing, format),
      ...(actorId ? { actorId } : {}),
      classification,
      ...text,
      card: { anchor: theme.layout.anchor, scale: 1, placement: 'auto' },
      evidence: { utteranceIds: evidence.map((u) => u.id), note: candidate.action },
      origin: 'ai',
      status: 'draft',
      confidence: Math.min(1, Math.max(0, move.confidence)),
    });
  });

  // The creator's work stays: approved moves and moves they added themselves.
  // Drafts go on most confident first, each at least the format's gap from the rest.
  const kept = project.moments.filter((m) => m.origin === 'user' || m.status === 'approved');
  const track = [...kept];
  const gap = Math.max(MIN_MOMENT_GAP_SEC, FORMAT_RULES[format].minCardGapSec);
  const clear = (t: number) => track.every((m) => Math.abs(m.sourceTime - t) >= gap - 1e-9);
  for (const moment of [...placed].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
    if (track.some((m) => m.id === moment.id)) moment.id = `${moment.id}-${track.length}`;
    if (clear(moment.sourceTime)) track.push(moment);
    else dropped.push({ candidateId: moment.id, reason: 'too close to another move' });
  }
  return { moments: track.sort((a, b) => a.sourceTime - b.sourceTime), dropped };
}
