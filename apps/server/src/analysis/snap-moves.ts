import {
  MIN_MOMENT_GAP_SEC,
  NO_BEST_MOVE,
  autoHoldSec,
  cleanFreezeTime,
  freezeAfterSpeech,
  type Annotation,
  type Candidate,
  type Moment,
  type Project,
  type Theme,
} from '@als/schema';

export interface SnapResult {
  moments: Moment[];
  /** Moves that could not be placed, with why. */
  dropped: { candidateId: string; reason: string }[];
}

/**
 * Stage 4: places each annotated move on an exact frame and merges the drafts
 * into the track. Spoken moves freeze just after their last word, in that
 * word's shot; visual moves on the nearest clean frame. Moves the creator
 * approved or added are kept; AI drafts are replaced.
 */
export function snapMoves(project: Project, candidates: Candidate[], moves: Annotation['moves'], theme: Theme): SnapResult {
  const { fps, durationSec } = project.source;
  const shots = project.shots ?? [];
  const words = project.transcript?.words ?? [];
  const utterances = new Map((project.transcript?.utterances ?? []).map((u) => [u.id, u]));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const dropped: SnapResult['dropped'] = [];

  const characterFor = (name: string) => {
    const lower = name.trim().toLowerCase();
    const direct = project.context.characters.find((c) => c.name.trim().toLowerCase() === lower);
    if (direct) return direct.id;
    const label = /^speaker ([a-z]+)$/i.exec(name.trim())?.[1]?.toUpperCase();
    return label ? project.context.characters.find((c) => c.speakerLabels.includes(label))?.id : undefined;
  };

  const placed: Moment[] = [];
  moves.forEach((move, index) => {
    const candidate = byId.get(move.candidateId);
    if (!candidate) return dropped.push({ candidateId: move.candidateId, reason: 'unknown candidate' });
    const evidence = candidate.evidenceUtteranceIds.map((id) => utterances.get(id)).filter((u) => u !== undefined);

    let sourceTime: number;
    if ((candidate.kind === 'spoken' || candidate.visualTimeSec === null) && evidence.length) {
      const last = evidence.reduce((a, b) => (b.end > a.end ? b : a));
      const lastWordEnd = words[last.wordRange[1]]?.end ?? last.end;
      sourceTime = freezeAfterSpeech(lastWordEnd, shots, fps);
    } else if (candidate.visualTimeSec !== null) {
      const t = Math.min(Math.max(candidate.visualTimeSec, 0), durationSec);
      sourceTime = cleanFreezeTime(t, shots, fps);
    } else {
      return dropped.push({ candidateId: candidate.id, reason: 'no evidence or time to place it' });
    }
    sourceTime = Math.min(sourceTime, durationSec);

    const actorId = characterFor(candidate.actor);
    const bestMove = NO_BEST_MOVE.has(move.classification) ? undefined : move.bestMove?.trim() || undefined;
    const text = { moveLabel: move.moveLabel.trim(), explanation: move.explanation.trim(), ...(bestMove ? { bestMove } : {}) };
    placed.push({
      id: `ai-${candidate.id}-${index + 1}`,
      sourceTime,
      holdSec: autoHoldSec(text, theme.timing),
      ...(actorId ? { actorId } : {}),
      classification: move.classification,
      ...text,
      card: { anchor: theme.layout.anchor, scale: 1 },
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
