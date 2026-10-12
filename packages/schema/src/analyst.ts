import { z } from 'zod';
import { ClassificationSchema } from './classification.ts';
import type { Eval } from './eval.ts';
import { TEXT_CAPS } from './rules.ts';

// Structured outputs for the analysis pipeline. They are built per clip so the
// cast, the candidate ids and the transcript's utterance ids are enums: the
// model cannot cite evidence that does not exist. Text caps are given in the
// prompt rather than as maxLength, because structured outputs drop length
// constraints; the editor flags anything over (momentWarnings).

/** Fallback when a list would be empty: enums need at least one value. */
const enumOf = (values: readonly string[], fallback: string) =>
  z.enum((values.length ? [...new Set(values)] : [fallback]) as [string, ...string[]]);

/** Speaker naming: one name per diarization label. */
export const speakerNamingSchema = (labels: readonly string[]) =>
  z.object({
    speakers: z.array(
      z.object({
        label: enumOf(labels, 'A'),
        name: z.string().describe('Character name as the film uses it, or a short description such as "Security guard"'),
        confidence: z.number().describe('0-1'),
      }),
    ),
  });

/** Pass A: every decision point, over-generated on purpose. */
export const decisionPointsSchema = (cast: readonly string[], utteranceIds: readonly string[]) =>
  z.object({
    candidates: z.array(
      z.object({
        id: z.string().describe('Short unique id, e.g. "c1"'),
        actor: enumOf(cast, 'Unknown'),
        kind: z.enum(['spoken', 'visual']).describe('spoken: the choice is made in dialogue; visual: in action on screen'),
        action: z.string().describe('What the character did, in a sentence'),
        alternatives: z.array(z.string()).describe('Other options that were open to them'),
        evidenceUtteranceIds: z.array(enumOf(utteranceIds, 'none')).describe('Utterances that show the choice; empty for purely visual moves'),
        visualTimeSec: z.number().nullable().describe('For visual moves, when the action happens (seconds); null for spoken moves'),
      }),
    ),
  });
export type DecisionPoints = z.infer<ReturnType<typeof decisionPointsSchema>>;
export type Candidate = DecisionPoints['candidates'][number];

const moveFields = {
  classification: ClassificationSchema,
  moveLabel: z.string().describe(`Move name: two or three words in Title Case (${TEXT_CAPS.moveLabel} characters at most)`),
  explanation: z
    .string()
    .describe(`Two sentences: what they did, then why it earned this rating (${TEXT_CAPS.explanation} characters at most)`),
  bestMove: z
    .string()
    .nullable()
    .describe(
      `The better move: a two to four word command in Title Case (${TEXT_CAPS.bestMove} characters at most); null for brilliant, great, best and book`,
    ),
  motif: z
    .string()
    .nullable()
    .describe(
      `The chess idea behind the move as a short Title Case chip (${TEXT_CAPS.motif} characters at most), e.g. Sacrifice, Zwischenzug, Quiet Move, Check, Fork, Pin, Gambit; null when none fits`,
    ),
  confidence: z.number().describe('0-1: how sure you are this belongs in the episode as rated'),
};

/** Pass B: the final moves, rated and written, and who plays White. */
export const annotationSchema = (candidateIds: readonly string[], cast: readonly string[]) =>
  z.object({
    protagonist: enumOf(cast, 'Unknown')
      .nullable()
      .describe("The scene's protagonist, who plays White; null if no one stands out"),
    moves: z.array(z.object({ candidateId: enumOf(candidateIds, 'none'), ...moveFields })),
  });
export type Annotation = z.infer<ReturnType<typeof annotationSchema>>;

/** Pass B for one moment (Regenerate, and "Make this a move"). */
export const MoveDraftSchema = z.object(moveFields);
export type MoveDraft = z.infer<typeof MoveDraftSchema>;

/**
 * An eval as the model writes it: structured outputs have no unions of
 * objects, so pawns and mate are both nullable and `toEval` picks one.
 */
const evalFields = {
  pawns: z.number().nullable().describe("White's advantage in pawns, one decimal, negative when Black is ahead; null when there is a mate"),
  mate: z.int().nullable().describe('Forced mate in this many moves, positive when White mates and negative when Black does; null otherwise'),
};

/** Pass C: one eval for every card and beat at once, so the bar tells one coherent story. */
export const evaluationSchema = (ids: readonly string[]) =>
  z.object({
    start: z.object(evalFields).describe('The position as the scene opens, before the first move'),
    evals: z.array(
      z.object({
        id: enumOf(ids, 'none'),
        ...evalFields,
        reason: z.string().describe('Why the bar moves here, in one short line'),
      }),
    ),
  });
export type Evaluation = z.infer<ReturnType<typeof evaluationSchema>>;

/** The model's pawns-or-mate pair as an Eval. A mate of 0 or a missing value reads as level. */
export const toEval = (e: { pawns: number | null; mate: number | null }): Eval =>
  e.mate !== null && e.mate !== 0
    ? { mate: Math.max(-99, Math.min(99, Math.trunc(e.mate))) }
    : { pawns: Math.max(-99, Math.min(99, Math.round((e.pawns ?? 0) * 10) / 10)) || 0 };

/** The creator's breakdowns, used as few-shot examples, plus a short voice guide. */
export const StyleCorpusSchema = z.object({
  /** How the creator writes: humour, sentence length, recurring phrasings. */
  voice: z.string(),
  examples: z.array(
    z.object({
      context: z.string().describe('One line of scene context'),
      /** `creator`: transcribed from their videos; `placeholder`: written to match until more arrive. */
      source: z.enum(['creator', 'placeholder']).optional(),
      classification: ClassificationSchema,
      moveLabel: z.string(),
      explanation: z.string(),
      bestMove: z.string().nullable().optional(),
      motif: z.string().nullable().optional(),
    }),
  ),
});
export type StyleCorpus = z.infer<typeof StyleCorpusSchema>;

