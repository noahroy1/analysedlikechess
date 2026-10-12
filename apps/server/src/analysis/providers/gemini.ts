import { FileState, GoogleGenAI, MediaResolution, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import type { Box, FaceRegion, SceneNote } from '@als/schema';
import { costUsd } from '../prices.ts';
import { ProviderError, type RegionContext, type RegionFinder, type SceneContext, type SceneDescriber } from './types.ts';

const POLL_MS = 2000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** What Gemini returns: time-ordered notes in seconds from the start of the clip. */
export const GeminiNotesSchema = z.object({
  notes: z.array(
    z.object({
      startSec: z.number(),
      endSec: z.number(),
      onScreen: z.array(z.string()).describe('Characters visible, by name if known'),
      text: z.string().describe('What happens: actions, reactions, reveals, objects that matter'),
    }),
  ),
});

export function scenePrompt(context: SceneContext, durationSec: number): string {
  const lines = [
    'You are watching a film scene that will be analysed like a chess game: each character choice is a "move".',
    'Write time-ordered scene notes covering the whole clip. Make a note at every beat: who is on screen, what they do,',
    'how others react, reveals, and any object or position that matters to the choices characters make.',
    'Do not transcribe dialogue word for word; a separate transcript has it. Do describe tone, glances and body language.',
    `Times are seconds from the start of the clip (0 to ${durationSec.toFixed(1)}). Keep notes 2 to 8 seconds long.`,
  ];
  if (context.movieTitle) lines.push(`The film is "${context.movieTitle}".`);
  if (context.sceneNote) lines.push(`The editor describes the scene as: ${context.sceneNote}.`);
  if (context.characterNames.length) lines.push(`Characters likely present: ${context.characterNames.join(', ')}.`);
  return lines.join('\n');
}

/** Gemini notes into project scene notes, clamped to the clip and in order. */
export function parseNotes(raw: z.infer<typeof GeminiNotesSchema>, durationSec: number): SceneNote[] {
  const clamp = (t: number) => Math.min(Math.max(0, t), durationSec);
  return raw.notes
    .map((n) => {
      const start = clamp(n.startSec);
      const end = Math.max(start, clamp(n.endSec));
      const who = n.onScreen.length ? `[${n.onScreen.join(', ')}] ` : '';
      return { start, end, text: `${who}${n.text}`.trim() };
    })
    .filter((n) => n.text)
    .sort((a, b) => a.start - b.start);
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fps: number;
  record?: (name: string, raw: unknown) => Promise<void>;
}

/** Gemini with native video input: uploads the proxy, asks for JSON scene notes. */
export function geminiDescriber({ apiKey, model, fps, record }: GeminiOptions): SceneDescriber {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async describe(videoPath, { durationSec, context }) {
      let file = await ai.files.upload({ file: videoPath, config: { mimeType: 'video/mp4' } });
      const started = Date.now();
      try {
        while (file.state === FileState.PROCESSING) {
          if (Date.now() - started > UPLOAD_TIMEOUT_MS) throw new ProviderError('Gemini took too long to process the video');
          await new Promise((r) => setTimeout(r, POLL_MS));
          file = await ai.files.get({ name: file.name! });
        }
        if (file.state === FileState.FAILED) throw new ProviderError('Gemini could not process the video');

        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { fileData: { fileUri: file.uri!, mimeType: file.mimeType ?? 'video/mp4' }, videoMetadata: { fps } },
                { text: scenePrompt(context, durationSec) },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: z.toJSONSchema(GeminiNotesSchema),
          },
        });
        const text = response.text;
        if (!text) throw new ProviderError('Gemini returned no scene notes');
        const raw = GeminiNotesSchema.parse(JSON.parse(text));
        await record?.('gemini', { raw, usageMetadata: response.usageMetadata });

        const meta = response.usageMetadata;
        const usage = {
          inputTokens: meta?.promptTokenCount ?? 0,
          outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
        };
        return { notes: parseNotes(raw, durationSec), model: `google/${model}`, usage, costUsd: costUsd(model, usage) };
      } finally {
        if (file.name) await ai.files.delete({ name: file.name }).catch(() => undefined);
      }
    },
  };
}

/** Gemini's boxes: [ymin, xmin, ymax, xmax], each 0-1000 of the image. */
const Box2d = z.array(z.number()).length(4);
export const GeminiRegionsSchema = z.object({
  faces: z
    .array(
      z.object({
        head: Box2d.describe('The whole head, hair to chin'),
        eyes_mouth: z.array(z.number()).max(4).describe('Top of the eyebrows to the bottom of the lower lip; empty for a head seen from behind'),
      }),
    )
    .describe('Every visible head'),
  subject: z.array(z.object({ box_2d: Box2d })).max(1).describe('The one region the viewer must see to follow the move; empty if it is just a face'),
});

/** Bump when the prompt or the parsing changes, so cached frames are looked at again. */
export const REGIONS_PROMPT_VERSION = 2;

export function regionsPrompt({ moveLabel, explanation, actorName }: RegionContext): string {
  return [
    'This is a frozen frame from a film scene. A card explaining a move will be drawn over it, and must not hide what matters.',
    `The move: "${moveLabel}"${actorName ? ` by ${actorName}` : ''}. ${explanation}`,
    'Return bounding boxes as box_2d [ymin, xmin, ymax, xmax] normalized to 0-1000:',
    '- faces: every visible head. head: from the hair to the chin, including heads seen from the side or behind and small ones in the distance.',
    '  eyes_mouth: a tight box from the top of the eyebrows to the bottom of the lower lip, across the outer corners of both eyes. Leave it empty for a head seen from behind.',
    '- subject: the one region the viewer must see to follow this move (a hand, an object, an action), as tight as possible. Leave it empty when the subject is just the mover\'s face.',
  ].join('\n');
}

/** Gemini boxes as frame fractions, clamped to the frame; empty boxes are dropped. */
export function parseRegions(raw: z.infer<typeof GeminiRegionsSchema>): { faces: FaceRegion[]; subject?: Box } {
  const box = (b: number[]): Box | undefined => {
    if (b.length !== 4) return undefined;
    const [y0, x0, y1, x1] = b;
    const c = (v: number) => Math.min(1, Math.max(0, v / 1000));
    const [top, bottom] = [c(Math.min(y0!, y1!)), c(Math.max(y0!, y1!))];
    const [left, right] = [c(Math.min(x0!, x1!)), c(Math.max(x0!, x1!))];
    return right - left > 0.002 && bottom - top > 0.002 ? { x: left, y: top, w: right - left, h: bottom - top } : undefined;
  };
  const faces = raw.faces.flatMap((f) => {
    const head = box(f.head);
    const eyesMouth = box(f.eyes_mouth);
    return head ? [eyesMouth ? { head, eyesMouth } : { head }] : [];
  });
  const subject = raw.subject[0] ? box(raw.subject[0].box_2d) : undefined;
  return subject ? { faces, subject } : { faces };
}

/**
 * Gemini on one still: faces and the move's subject. Medium media resolution
 * (560 tokens an image) finds the same faces as high for about two thirds of
 * the cost (measured Oct 13, 2026), and minimal thinking keeps it fast.
 */
export function geminiRegions({ apiKey, model, record }: Omit<GeminiOptions, 'fps'>): RegionFinder {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async find(jpeg, context) {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text: regionsPrompt(context) }] }],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: z.toJSONSchema(GeminiRegionsSchema),
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      });
      const text = response.text;
      if (!text) throw new ProviderError('Gemini returned no regions');
      const raw = GeminiRegionsSchema.parse(JSON.parse(text));
      await record?.('gemini-regions', { raw, usageMetadata: response.usageMetadata });
      const meta = response.usageMetadata;
      const usage = {
        inputTokens: meta?.promptTokenCount ?? 0,
        outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      };
      return { ...parseRegions(raw), model: `google/${model}`, usage, costUsd: costUsd(model, usage) };
    },
  };
}
