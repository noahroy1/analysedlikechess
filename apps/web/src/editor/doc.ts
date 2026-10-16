import {
  DEFAULT_START_EVAL,
  MIN_MOMENT_GAP_SEC,
  NO_BEST_MOVE,
  autoHoldSec,
  evalKeyframes,
  type Character,
  type Classification,
  type Eval,
  type EvalBar,
  type EvalBarScale,
  type EvalBeat,
  type EvaluateResult,
  type Format,
  type GameReview,
  type Moment,
  type Subtitle,
  type Theme,
  type Transcript,
  type Card,
  type FrameRegions,
  subtitlesFromTranscript,
} from '@als/schema';
import { autoPlaceCard, moveNumbers } from '@als/composition';

/** The part of a project the editor changes: its name, the annotation track, the cast, the look, the format, the evaluation bar, the subtitles and the game review. */
export interface Doc {
  /** Absent until the project is renamed. */
  title?: string;
  moments: Moment[];
  characters: Character[];
  themeId: string;
  /** Short- or long-form pacing; a project that never set one starts from its clip's guess. */
  format: Format;
  evalBar?: EvalBar;
  /** The bar's size; absent is 100%. */
  evalBarScale?: EvalBarScale;
  /** Absent while the subtitles follow the transcript; set by the first edit. */
  subtitles?: Subtitle[];
  /** Accuracy and summary as typed; absent shows the defaults. */
  gameReview?: GameReview;
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
      const holdSec = autoHoldSec(m, theme.timing, doc.format);
      return holdSec === m.holdSec ? m : { ...m, holdSec };
    });
  const evalBar = doc.evalBar && { ...doc.evalBar, beats: [...doc.evalBar.beats].sort((a, b) => a.sourceTime - b.sourceTime) };
  return { ...doc, moments, ...(evalBar ? { evalBar } : {}) };
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
    // Placed clear of faces once its frame has been looked at.
    card: { anchor: theme.layout.anchor, scale: 1, placement: 'auto' },
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
    ...doc,
    characters: doc.characters
      .filter((c) => c.id !== fromId)
      .map((c) => (c.id === intoId ? { ...c, speakerLabels: [...c.speakerLabels, ...from.speakerLabels] } : c)),
    moments: doc.moments.map((m) => (m.actorId === fromId ? { ...m, actorId: intoId } : m)),
    ...(doc.evalBar && {
      evalBar: { ...doc.evalBar, beats: doc.evalBar.beats.map((b) => (b.actorId === fromId ? { ...b, actorId: intoId } : b)) },
    }),
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
    ...doc,
    characters: doc.characters.filter((c) => c.id !== id),
    moments: doc.moments.map((m) => {
      if (m.actorId !== id) return m;
      const { actorId: _, ...rest } = m;
      return rest;
    }),
    ...(doc.evalBar && {
      evalBar: {
        ...doc.evalBar,
        beats: doc.evalBar.beats.map((b) => {
          if (b.actorId !== id) return b;
          const { actorId: _, ...rest } = b;
          return rest;
        }),
      },
    }),
  };
}

/** Frame size in composition pixels: the source's. */
export interface FrameSize {
  width: number;
  height: number;
}

/** A card moved, resized or re-anchored by hand: automatic placement leaves it alone from now on. */
export function setCardByHand(doc: Doc, id: string, card: Card): Doc {
  return updateMoment(doc, id, { card: { ...card, placement: 'user' } });
}

/** The grey line's text on a card ("2... Walter White"): placement needs it for the card's height. */
function whoLine(doc: Doc, moment: Moment): string {
  const number = moveNumbers(doc.moments, doc.characters).get(moment.id);
  const name = doc.characters.find((c) => c.id === moment.actorId)?.name;
  return [number, name].filter(Boolean).join(' ');
}

/** Places a move's card clear of its frame's faces, from now on automatically (Re-evaluate). */
export function placeCard(doc: Doc, id: string, regions: FrameRegions, theme: Theme, frame: FrameSize): Doc {
  const moment = doc.moments.find((m) => m.id === id);
  if (!moment) throw new EditError('That move no longer exists.');
  const placed = autoPlaceCard({ moment: { ...moment, regions }, theme, frame, who: whoLine(doc, moment), barScale: doc.evalBarScale });
  return updateMoment(doc, id, { regions, ...(placed ? { card: placed.card } : {}) });
}

/**
 * Regions that arrive after a retime or for a new move, if they still apply:
 * the move is still at that frame and its card is still placed automatically.
 */
export function applyFoundRegions(doc: Doc, id: string, regions: FrameRegions, theme: Theme, frame: FrameSize): Doc {
  const moment = doc.moments.find((m) => m.id === id);
  if (!moment || moment.card.placement !== 'auto' || Math.abs(moment.sourceTime - regions.sourceTime) > 1e-4) return doc;
  return placeCard(doc, id, regions, theme, frame);
}

/** Automatic cards whose regions are current go where they fit now (a new look changes the card's size and badge). */
export function replaceAutoCards(doc: Doc, theme: Theme, frame: FrameSize): Doc {
  return doc.moments.reduce(
    (d, m) => (m.card.placement === 'auto' && m.regions && Math.abs(m.regions.sourceTime - m.sourceTime) < 1e-4 ? placeCard(d, m.id, m.regions, theme, frame) : d),
    doc,
  );
}

/** Switches the project's look; unlocked holds follow the new theme's timing. */
export function setTheme(doc: Doc, themeId: string): Doc {
  return doc.themeId === themeId ? doc : { ...doc, themeId };
}

/** Switches between short- and long-form; unlocked holds follow the new format's reread. */
export function setFormat(doc: Doc, format: Format): Doc {
  return doc.format === format ? doc : { ...doc, format };
}

/** Sizes the evaluation bar; 1 (full size) is stored as absent. Cards placed automatically move to fit the bar's new room. */
export function setEvalBarScale(doc: Doc, scale: EvalBarScale | 1): Doc {
  if ((doc.evalBarScale ?? 1) === scale) return doc;
  const { evalBarScale: _, ...rest } = doc;
  return scale === 1 ? rest : { ...rest, evalBarScale: scale };
}

/** The doc with its game review replaced; nothing left typed drops it. */
function withGameReview(doc: Doc, review: GameReview): Doc {
  const { gameReview: _, ...rest } = doc;
  const accuracy = review.accuracy && Object.keys(review.accuracy).length > 0 ? review.accuracy : undefined;
  const next: GameReview = { ...(accuracy ? { accuracy } : {}), ...(review.summary ? { summary: review.summary } : {}) };
  return Object.keys(next).length > 0 ? { ...rest, gameReview: next } : rest;
}

/** A side's accuracy on the game review, 0-100 to one decimal; undefined goes back to the default. */
export function setReviewAccuracy(doc: Doc, side: 'white' | 'black', value: number | undefined): Doc {
  const current = doc.gameReview?.accuracy?.[side];
  const next = value === undefined ? undefined : Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
  if (current === next) return doc;
  const { [side]: _, ...others } = doc.gameReview?.accuracy ?? {};
  return withGameReview(doc, { ...doc.gameReview, accuracy: next === undefined ? others : { ...others, [side]: next } });
}

/** The game review's summary line, kept as typed; blank goes back to the one written from the result. */
export function setReviewSummary(doc: Doc, text: string): Doc {
  const summary = text.trim() ? text : undefined;
  if (doc.gameReview?.summary === summary) return doc;
  const { summary: _, ...rest } = doc.gameReview ?? {};
  return withGameReview(doc, summary ? { ...rest, summary } : rest);
}

/** Renames the project; a blank name goes back to the movie title or the file's name. */
export function setTitle(doc: Doc, title: string): Doc {
  const next = title.trim();
  if ((doc.title ?? '') === next) return doc;
  const { title: _, ...rest } = doc;
  return next ? { ...rest, title: next } : rest;
}

/** The colour a character plays, for move numbers; undefined clears it. */
export function setSide(doc: Doc, id: string, side: Character['side']): Doc {
  return {
    ...doc,
    characters: doc.characters.map((c) => {
      if (c.id !== id) return c;
      const { side: _, ...rest } = c;
      return side ? { ...rest, side } : rest;
    }),
  };
}

/** A character's portrait file beside the bar; undefined clears it. */
export function setPortrait(doc: Doc, id: string, file: string | undefined): Doc {
  return {
    ...doc,
    characters: doc.characters.map((c) => {
      if (c.id !== id) return c;
      const { portrait: _, ...rest } = c;
      return file ? { ...rest, portrait: file } : rest;
    }),
  };
}

// The evaluation bar

/** A move or a beat: they share one id space. */
export const hasItem = (doc: Doc, id: string | null): boolean =>
  id !== null && (doc.moments.some((m) => m.id === id) || (doc.evalBar?.beats.some((b) => b.id === id) ?? false));

const barOf = (doc: Doc): EvalBar => doc.evalBar ?? { start: DEFAULT_START_EVAL, beats: [] };

/** A move's eval; undefined clears it, so the bar holds through the move. */
export function setMomentEval(doc: Doc, id: string, value: Eval | undefined): Doc {
  return {
    ...doc,
    moments: doc.moments.map((m) => {
      if (m.id !== id) return m;
      const { eval: _, ...rest } = m;
      return value ? { ...rest, eval: value } : rest;
    }),
  };
}

export function setStartEval(doc: Doc, start: Eval): Doc {
  return { ...doc, evalBar: { ...barOf(doc), start } };
}

/** What the bar reads just before a source time: the latest change at or before it, else the start. */
export function evalBefore(doc: Doc, sec: number): Eval {
  const before = evalKeyframes(doc.evalBar, doc.moments, doc.characters).filter((k) => k.sourceTime <= sec);
  return before.at(-1)?.eval ?? barOf(doc).start;
}

/** What the bar reads just before a move or beat changes it (a move with no eval: what it holds). */
export function evalBeforeItem(doc: Doc, id: string, sec: number): Eval {
  const own = evalKeyframes(doc.evalBar, doc.moments, doc.characters).find((k) => k.id === id);
  return own ? own.before : evalBefore(doc, sec);
}

/** A new beat holding the bar's current value, so adding one never jumps the bar. */
export function addBeat(doc: Doc, init: { sourceTime: number; actorId?: string }, durationSec: number): { doc: Doc; id: string } {
  const sourceTime = Math.min(Math.max(init.sourceTime, 0), durationSec);
  const beat: EvalBeat = {
    id: newId('beat'),
    sourceTime,
    eval: evalBefore(doc, sourceTime),
    ...(init.actorId ? { actorId: init.actorId } : {}),
    origin: 'user',
  };
  const bar = barOf(doc);
  return { doc: { ...doc, evalBar: { ...bar, beats: [...bar.beats, beat] } }, id: beat.id };
}

/** Changes a beat; a time is kept inside the clip. Undefined optional fields are removed. */
export function updateBeat(doc: Doc, id: string, patch: Partial<Omit<EvalBeat, 'id'>>, durationSec: number): Doc {
  const bar = barOf(doc);
  const beats = bar.beats.map((b) => {
    if (b.id !== id) return b;
    const next: Record<string, unknown> = { ...b, ...patch };
    if (patch.sourceTime !== undefined) next.sourceTime = Math.min(Math.max(patch.sourceTime, 0), durationSec);
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    return next as EvalBeat;
  });
  return { ...doc, evalBar: { ...bar, beats } };
}

export function deleteBeat(doc: Doc, id: string): Doc {
  if (!doc.evalBar) return doc;
  return { ...doc, evalBar: { ...doc.evalBar, beats: doc.evalBar.beats.filter((b) => b.id !== id) } };
}

/**
 * Puts a Re-evaluate result on the track. Existing beats keep their place and
 * take the new values; a track with no bar yet takes the proposed beats too.
 * Moves without a proposed value keep theirs.
 */
export function applyEvaluation(doc: Doc, result: Pick<EvaluateResult, 'evalBar' | 'evals'>): Doc {
  const proposed = new Map(result.evalBar.beats.map((b) => [b.id, b]));
  const beats = doc.evalBar
    ? doc.evalBar.beats.map((b) => {
        const p = proposed.get(b.id);
        return p ? { ...b, eval: p.eval, ...(p.reason ? { reason: p.reason } : {}) } : b;
      })
    : result.evalBar.beats;
  return {
    ...doc,
    moments: doc.moments.map((m) => (result.evals[m.id] ? { ...m, eval: result.evals[m.id]! } : m)),
    evalBar: { start: result.evalBar.start, beats },
  };
}

// Subtitles. Until the first edit they follow the transcript; an edit keeps
// the whole list in the document from then on.

/** The subtitles the episode shows: as edited, else built from the transcript. */
export const subtitlesOf = (doc: Pick<Doc, 'subtitles'>, transcript: Transcript | undefined): Subtitle[] =>
  doc.subtitles ?? subtitlesFromTranscript(transcript);

/** Shortest a subtitle can be retimed to. */
export const MIN_SUBTITLE_SEC = 0.2;

function editSubtitle(doc: Doc, transcript: Transcript | undefined, id: string, change: (s: Subtitle) => Subtitle | null): Doc {
  const current = subtitlesOf(doc, transcript);
  if (!current.some((s) => s.id === id)) throw new EditError('That subtitle no longer exists.');
  const subtitles = current.flatMap((s) => {
    if (s.id !== id) return [s];
    const next = change(s);
    return next ? [next] : [];
  });
  return { ...doc, subtitles: subtitles.sort((a, b) => a.start - b.start) };
}

export const setSubtitleText = (doc: Doc, transcript: Transcript | undefined, id: string, text: string): Doc =>
  editSubtitle(doc, transcript, id, (s) => ({ ...s, text }));

export const deleteSubtitle = (doc: Doc, transcript: Transcript | undefined, id: string): Doc =>
  editSubtitle(doc, transcript, id, () => null);

/** Moves a subtitle's start or end, keeping it at least `MIN_SUBTITLE_SEC` long. */
export const retimeSubtitle = (doc: Doc, transcript: Transcript | undefined, id: string, edge: 'start' | 'end', sec: number): Doc =>
  editSubtitle(doc, transcript, id, (s) =>
    edge === 'start' ? { ...s, start: Math.min(Math.max(0, sec), s.end - MIN_SUBTITLE_SEC) } : { ...s, end: Math.max(sec, s.start + MIN_SUBTITLE_SEC) },
  );

/** Drops every subtitle edit, so the lines follow the transcript again. */
export function followTranscript(doc: Doc): Doc {
  const { subtitles: _, ...rest } = doc;
  return rest;
}
