import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { AudioEvent, Utterance, Word } from '@als/schema';
import { SCRIBE_KEYTERM_SURCHARGE, costUsd } from '../prices.ts';
import { ProviderError, type Transcriber, type TranscribeResult } from './types.ts';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

/** A pause this long (s) between words of one speaker starts a new utterance. */
const UTTERANCE_GAP_SEC = 1.0;

// The subset of Scribe's response we read (docs: /v1/speech-to-text, Oct 2026).
const ScribeResponse = z.object({
  words: z.array(
    z.looseObject({
      text: z.string(),
      type: z.enum(['word', 'spacing', 'audio_event']),
      start: z.number().nullable().optional(),
      end: z.number().nullable().optional(),
      speaker_id: z.string().nullable().optional(),
    }),
  ),
});

/**
 * Scribe's flat word list into the project transcript: words with speaker
 * labels A, B, C… (in order of first appearance), utterances split on a
 * change of speaker or a long pause, and tagged sound events kept apart.
 */
export function parseScribe(raw: unknown): TranscribeResult['transcript'] {
  const { words: items } = ScribeResponse.parse(raw);
  const labels = new Map<string, string>();
  const labelOf = (id: string | null | undefined) => {
    const key = id ?? 'unknown';
    if (!labels.has(key)) labels.set(key, String.fromCharCode(65 + labels.size));
    return labels.get(key)!;
  };

  const words: Word[] = [];
  const events: AudioEvent[] = [];
  for (const item of items) {
    if (item.start == null || item.end == null) continue;
    if (item.type === 'audio_event') {
      events.push({ start: item.start, end: Math.max(item.start, item.end), text: item.text });
    } else if (item.type === 'word' && item.text.trim()) {
      words.push({ i: words.length, text: item.text.trim(), start: item.start, end: Math.max(item.start, item.end), speaker: labelOf(item.speaker_id) });
    }
  }

  const utterances: Utterance[] = [];
  let first = 0;
  words.forEach((word, i) => {
    const next = words[i + 1];
    if (next && next.speaker === word.speaker && next.start - word.end < UTTERANCE_GAP_SEC) return;
    const span = words.slice(first, i + 1);
    utterances.push({
      id: `u${utterances.length + 1}`,
      speaker: word.speaker,
      start: span[0]!.start,
      end: word.end,
      text: span.map((w) => w.text).join(' '),
      wordRange: [first, i],
    });
    first = i + 1;
  });

  return { words, utterances, events };
}

export interface ScribeOptions {
  apiKey: string;
  model: string;
  /** Saves each raw response, for refreshing test fixtures. */
  record?: (name: string, raw: unknown) => Promise<void>;
}

/** ElevenLabs Scribe: word timestamps, diarization and sound-event tags in one synchronous call. */
export function scribeTranscriber({ apiKey, model, record }: ScribeOptions): Transcriber {
  return {
    async transcribe(audioPath, { keyterms, durationSec }) {
      const form = new FormData();
      form.append('model_id', model);
      form.append('file', new Blob([await readFile(audioPath)], { type: 'audio/wav' }), basename(audioPath));
      form.append('diarize', 'true');
      form.append('timestamps_granularity', 'word');
      form.append('tag_audio_events', 'true');
      // Character names help it spell them. The docs don't show how a list is encoded;
      // repeated fields (the multipart convention) get HTTP 200. TODO(verify): that it changes spelling.
      for (const term of keyterms) form.append('keyterms', term);

      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form });
      const body: unknown = await res.json().catch(() => undefined);
      if (!res.ok) throw new ProviderError(`ElevenLabs transcription failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
      await record?.('elevenlabs', body);

      const usage = { audioSec: durationSec };
      return {
        transcript: parseScribe(body),
        model: `elevenlabs/${model}`,
        usage,
        costUsd: costUsd(model, usage, keyterms.length ? SCRIBE_KEYTERM_SURCHARGE : 0),
      };
    },
  };
}
