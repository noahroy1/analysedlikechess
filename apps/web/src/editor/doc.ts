import {
  MIN_MOMENT_GAP_SEC,
  NO_BEST_MOVE,
  autoHoldSec,
  type Character,
  type Classification,
  type Moment,
  type Theme,
} from '@als/schema';

/** The part of a project the editor changes: the annotation track and the cast. */
export interface Doc {
  moments: Moment[];
  characters: Character[];
}

export class EditError extends Error {}

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Keeps the track sorted, drops best moves from ratings that never have one,
 * and keeps every unlocked hold following its text.
 */
export function normalize(doc: Doc, theme: Theme): Doc {
  const moments = [...doc.moments]
    .sort((a, b) => a.sourceTime - b.sourceTime)
    .map((m) => {
      if (m.bestMove !== undefined && NO_BEST_MOVE.has(m.classification)) {
        const { bestMove: _, ...rest } = m;
        m = rest;
      }
      if (m.holdLocked) return m;
      const holdSec = autoHoldSec(m, theme.timing);
      return holdSec === m.holdSec ? m : { ...m, holdSec };
    });
  return { ...doc, moments };
}

/** The closest time to `sec` where a moment fits, respecting the clip and the minimum gap. */
export function clampTime(moments: readonly Moment[], id: string | null, sec: number, durationSec: number): number {
  const others = moments.filter((m) => m.id !== id);
  const current = moments.find((m) => m.id === id);
  // A moment never jumps past its neighbours: retiming keeps the track's order.
  const before = current ? others.filter((m) => m.sourceTime <= current.sourceTime).at(-1) : undefined;
  const after = current ? others.find((m) => m.sourceTime > current.sourceTime) : undefined;
  const lo = before ? before.sourceTime + MIN_MOMENT_GAP_SEC : 0;
  const hi = after ? after.sourceTime - MIN_MOMENT_GAP_SEC : durationSec;
  return Math.min(Math.max(sec, lo), hi);
}

export function hasRoomAt(moments: readonly Moment[], sec: number, durationSec: number): boolean {
  return (
    sec >= 0 && sec <= durationSec && moments.every((m) => Math.abs(m.sourceTime - sec) >= MIN_MOMENT_GAP_SEC - 1e-9)
  );
}

export function updateMoment(doc: Doc, id: string, patch: Partial<Moment>): Doc {
  return { ...doc, moments: doc.moments.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
}

export function retime(doc: Doc, id: string, sec: number, durationSec: number): Doc {
  return updateMoment(doc, id, { sourceTime: clampTime(doc.moments, id, sec, durationSec) });
}

export function addMoment(
  doc: Doc,
  init: { sourceTime: number; utteranceIds?: string[]; actorId?: string },
  theme: Theme,
  durationSec: number,
): { doc: Doc; id: string } {
  if (!hasRoomAt(doc.moments, init.sourceTime, durationSec)) {
    throw new EditError(`Moments need ${MIN_MOMENT_GAP_SEC} s between them; there is another one too close.`);
  }
  const moment: Moment = {
    id: newId('m'),
    sourceTime: init.sourceTime,
    holdSec: 1,
    ...(init.actorId ? { actorId: init.actorId } : {}),
    classification: 'good',
    moveLabel: '',
    explanation: '',
    card: { anchor: theme.layout.anchor, scale: 1 },
    evidence: { utteranceIds: init.utteranceIds ?? [] },
    origin: 'user',
    status: 'draft',
  };
  return { doc: { ...doc, moments: [...doc.moments, moment] }, id: moment.id };
}

export function deleteMoment(doc: Doc, id: string): Doc {
  return { ...doc, moments: doc.moments.filter((m) => m.id !== id) };
}

export function setClassification(doc: Doc, id: string, classification: Classification): Doc {
  return updateMoment(doc, id, { classification });
}

export function setStatus(doc: Doc, ids: readonly string[], status: Moment['status']): Doc {
  const set = new Set(ids);
  return { ...doc, moments: doc.moments.map((m) => (set.has(m.id) ? { ...m, status } : m)) };
}

// Characters

export function addCharacter(doc: Doc, name: string): Doc {
  return { ...doc, characters: [...doc.characters, { id: newId('c'), name, speakerLabels: [] }] };
}

export function renameCharacter(doc: Doc, id: string, name: string): Doc {
  return { ...doc, characters: doc.characters.map((c) => (c.id === id ? { ...c, name } : c)) };
}

/** Folds `fromId` into `intoId`: its speaker labels and every move it made. */
export function mergeCharacters(doc: Doc, fromId: string, intoId: string): Doc {
  const from = doc.characters.find((c) => c.id === fromId);
  if (!from || fromId === intoId) return doc;
  return {
    characters: doc.characters
      .filter((c) => c.id !== fromId)
      .map((c) => (c.id === intoId ? { ...c, speakerLabels: [...c.speakerLabels, ...from.speakerLabels] } : c)),
    moments: doc.moments.map((m) => (m.actorId === fromId ? { ...m, actorId: intoId } : m)),
  };
}

/** Gives a diarization label to one character, or to nobody. */
export function assignSpeaker(doc: Doc, label: string, characterId: string | null): Doc {
  return {
    ...doc,
    characters: doc.characters.map((c) => {
      const labels = c.speakerLabels.filter((l) => l !== label);
      return { ...c, speakerLabels: c.id === characterId ? [...labels, label] : labels };
    }),
  };
}

export function deleteCharacter(doc: Doc, id: string): Doc {
  return {
    characters: doc.characters.filter((c) => c.id !== id),
    moments: doc.moments.map((m) => {
      if (m.actorId !== id) return m;
      const { actorId: _, ...rest } = m;
      return rest;
    }),
  };
}
