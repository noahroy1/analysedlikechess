import {
  MIN_MOMENT_GAP_SEC,
  NO_BEST_MOVE,
  autoHoldSec,
  relabelLateBook,
  cleanFreezeTime,
  freezeAfterSpeech,
  type Annotation,
  type Candidate,
  type Moment,
  type Project,
  type Theme,
} from '@als/schema';
import { characterByName } from './sides.ts';

export interface SnapResult {
  moments: Moment[];
  /** Moves that could not be placed, with why. */
  dropped: { candidateId: string; reason: string }[];
}

/**
 * When a candidate's move happens: a spoken move just after its last word, in
 * that word's shot; a visual move on the nearest clean frame. Undefined when
 * there is neither evidence nor a time.
 */
export function candidateTime(project: Project, candidate: Candidate): number | undefined {
  const { fps, durationSec } = project.source;
  const shots = project.shots ?? [];
  const words = project.transcript?.words ?? [];
  const utterances = new Map((project.transcript?.utterances ?? []).map((u) => [u.id, u]));
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
 * word's shot; visual moves on the nearest clean frame. Moves the creator
 * approved or added are kept; AI drafts are replaced.
 */
export function snapMoves(project: Project, candidates: Candidate[], moves: Annotation['moves'], theme: Theme): SnapResult {
  const utterances = new Map((project.transcript?.utterances ?? []).map((u) => [u.id, u]));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const dropped: SnapResult['dropped'] = [];

  const characterFor = (name: string) => characterByName(project.context.characters, name)?.id;

  const placed: Moment[] = [];
  moves.forEach((move, index) => {
    const candidate = byId.get(move.candidateId);
    if (!candidate) return dropped.push({ candidateId: move.candidateId, reason: 'unknown candidate' });
    const evidence = candidate.evidenceUtteranceIds.map((id) => utterances.get(id)).filter((u) => u !== undefined);
    const sourceTime = candidateTime(project, candidate);
    if (sourceTime === undefined) return dropped.push({ candidateId: candidate.id, reason: 'no evidence or time to place it' });

    const actorId = characterFor(candidate.actor);
    const classification = relabelLateBook(move.classification, sourceTime);
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
      holdSec: autoHoldSec(text, theme.timing),
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
  const kept = project.moments.filter((m) => m.origin === 'user' || m.status === 'approved');
  const track = [...kept];
  const clear = (t: number) => track.every((m) => Math.abs(m.sourceTime - t) >= MIN_MOMENT_GAP_SEC - 1e-9);
  for (const moment of [...placed].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
    if (track.some((m) => m.id === moment.id)) moment.id = `${moment.id}-${track.length}`;
    if (clear(moment.sourceTime)) track.push(moment);
    else dropped.push({ candidateId: moment.id, reason: 'too close to another move' });
  }
  return { moments: track.sort((a, b) => a.sourceTime - b.sourceTime), dropped };
}
