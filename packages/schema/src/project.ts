import { z } from 'zod';
import { ClassificationSchema } from './classification.ts';
import { MIN_MOMENT_GAP_SEC } from './rules.ts';

// All times are source-clip seconds. Frames are always derived, never stored.

const Id = z.string().min(1);
const Seconds = z.number().nonnegative();
const Unit = z.number().min(0).max(1);

export const CharacterSchema = z.object({
  id: Id,
  name: z.string(),
  speakerLabels: z.array(z.string()),
});
export type Character = z.infer<typeof CharacterSchema>;

export const WordSchema = z
  .object({
    i: z.int().nonnegative(),
    text: z.string(),
    start: Seconds,
    end: Seconds,
    speaker: z.string(),
  })
  .refine((w) => w.end >= w.start, { message: 'word ends before it starts', path: ['end'] });
export type Word = z.infer<typeof WordSchema>;

export const UtteranceSchema = z
  .object({
    id: Id,
    speaker: z.string(),
    start: Seconds,
    end: Seconds,
    text: z.string(),
    /** Inclusive indices of the first and last word in `transcript.words`. */
    wordRange: z.tuple([z.int().nonnegative(), z.int().nonnegative()]),
  })
  .refine((u) => u.end >= u.start, { message: 'utterance ends before it starts', path: ['end'] })
  .refine((u) => u.wordRange[1] >= u.wordRange[0], {
    message: 'wordRange is reversed',
    path: ['wordRange'],
  });
export type Utterance = z.infer<typeof UtteranceSchema>;

export const TranscriptSchema = z.object({
  words: z.array(WordSchema),
  utterances: z.array(UtteranceSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

const SpanSchema = z
  .object({ start: Seconds, end: Seconds })
  .refine((s) => s.end > s.start, { message: 'span must end after it starts', path: ['end'] });

export const ShotSchema = SpanSchema;
export type Shot = z.infer<typeof ShotSchema>;

export const SceneNoteSchema = z
  .object({ start: Seconds, end: Seconds, text: z.string() })
  .refine((s) => s.end >= s.start, { message: 'note ends before it starts', path: ['end'] });
export type SceneNote = z.infer<typeof SceneNoteSchema>;

export const CARD_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'] as const;

export const CardSchema = z
  .object({
    anchor: z.enum(CARD_ANCHORS),
    /** 0-1 of frame size, only for `custom`. */
    x: Unit.optional(),
    y: Unit.optional(),
    scale: z.number().positive(),
  })
  .refine((c) => c.anchor !== 'custom' || (c.x !== undefined && c.y !== undefined), {
    message: 'a custom anchor needs x and y',
    path: ['anchor'],
  });
export type Card = z.infer<typeof CardSchema>;

export const MomentSchema = z.object({
  id: Id,
  /** Where the video freezes. */
  sourceTime: Seconds,
  /** Freeze length in the output. */
  holdSec: z.number().positive(),
  /** Character who made the move. */
  actorId: Id.optional(),
  classification: ClassificationSchema,
  /** What they did, short. */
  moveLabel: z.string(),
  /** Why it earned this rating. */
  explanation: z.string(),
  /** Omitted for best and brilliant. */
  bestMove: z.string().optional(),
  card: CardSchema,
  /** Why the AI chose this time. */
  evidence: z.object({
    utteranceIds: z.array(Id),
    note: z.string().optional(),
  }),
  origin: z.enum(['ai', 'user']),
  status: z.enum(['draft', 'approved']),
  /** 0-1, from the Analyst. */
  confidence: Unit.optional(),
});
export type Moment = z.infer<typeof MomentSchema>;

export const SourceSchema = z.object({
  file: z.string().min(1),
  proxy: z.string().min(1),
  fps: z.number().positive(),
  durationSec: z.number().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  hasAudio: z.boolean(),
});
export type Source = z.infer<typeof SourceSchema>;

export const AnalysisSchema = z.object({
  status: z.enum(['idle', 'running', 'done', 'error']),
  stages: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      error: z.string().optional(),
    }),
  ),
  /** Which model produced what. */
  models: z.record(z.string(), z.string()),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const ProjectSchema = z
  .object({
    id: Id,
    /** +1 on every save, used for conflict checks. */
    version: z.int().nonnegative(),
    source: SourceSchema,
    /** Optional, typed by the creator at upload. */
    context: z.object({
      movieTitle: z.string().optional(),
      sceneNote: z.string().optional(),
      characters: z.array(CharacterSchema),
    }),
    transcript: TranscriptSchema.optional(),
    /** Cut boundaries. */
    shots: z.array(ShotSchema).optional(),
    /** Timestamped visual descriptions. */
    sceneNotes: z.array(SceneNoteSchema).optional(),
    /** The annotation track, sorted by sourceTime. */
    moments: z.array(MomentSchema),
    themeId: Id,
    analysis: AnalysisSchema,
  })
  .superRefine((project, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });

    const duplicates = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);

    for (const id of duplicates(project.context.characters.map((c) => c.id))) {
      issue(`duplicate character id "${id}"`, ['context', 'characters']);
    }
    for (const label of duplicates(project.context.characters.flatMap((c) => c.speakerLabels))) {
      issue(`speaker label "${label}" is assigned to more than one character`, ['context', 'characters']);
    }

    const words = project.transcript?.words ?? [];
    const utterances = project.transcript?.utterances ?? [];
    for (const id of duplicates(utterances.map((u) => u.id))) {
      issue(`duplicate utterance id "${id}"`, ['transcript', 'utterances']);
    }
    utterances.forEach((u, i) => {
      if (u.wordRange[1] >= words.length) {
        issue(`wordRange ${u.wordRange[1]} is past the last word`, ['transcript', 'utterances', i, 'wordRange']);
      }
    });

    const characterIds = new Set(project.context.characters.map((c) => c.id));
    const utteranceIds = new Set(utterances.map((u) => u.id));
    for (const id of duplicates(project.moments.map((m) => m.id))) {
      issue(`duplicate moment id "${id}"`, ['moments']);
    }

    project.moments.forEach((m, i) => {
      const path = ['moments', i];
      if (m.sourceTime > project.source.durationSec) {
        issue(`sourceTime ${m.sourceTime} is past the end of the clip`, [...path, 'sourceTime']);
      }
      if (m.actorId !== undefined && !characterIds.has(m.actorId)) {
        issue(`actorId "${m.actorId}" is not a character`, [...path, 'actorId']);
      }
      m.evidence.utteranceIds.forEach((id, j) => {
        if (!utteranceIds.has(id)) {
          issue(`evidence utterance "${id}" is not in the transcript`, [...path, 'evidence', 'utteranceIds', j]);
        }
      });

      // Holds take no source time, so keeping moments strictly ordered and at
      // least MIN_MOMENT_GAP_SEC apart also keeps each one out of the others' holds.
      const prev = project.moments[i - 1];
      if (prev) {
        const gap = m.sourceTime - prev.sourceTime;
        if (gap < 0) {
          issue('moments must be sorted by sourceTime', [...path, 'sourceTime']);
        } else if (gap < MIN_MOMENT_GAP_SEC - 1e-9) {
          issue(
            `moment is ${gap.toFixed(3)} s after the previous one; the minimum is ${MIN_MOMENT_GAP_SEC} s`,
            [...path, 'sourceTime'],
          );
        }
      }
    });
  });
export type Project = z.infer<typeof ProjectSchema>;
