import { FileState, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { SceneNote } from '@als/schema';
import { costUsd } from '../prices.ts';
import { ProviderError, type SceneContext, type SceneDescriber } from './types.ts';

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
