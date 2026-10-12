import { z } from 'zod';
import type { Transcript, Word } from './project.ts';

/**
 * Burned-in subtitles: one line of dialogue on screen from `start` to `end`,
 * in source seconds. They live in source time, so during a hold the line
 * spoken before the freeze stays up, as in the creator's videos.
 */
export const SubtitleSchema = z
  .object({
    id: z.string().min(1),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    text: z.string(),
  })
  .refine((s) => s.end > s.start, { message: 'subtitle ends before it starts', path: ['end'] });
export type Subtitle = z.infer<typeof SubtitleSchema>;

/**
 * Longest line built from the transcript; longer sentences are split. The
 * creator's lines are short single sentences ("Step out of the bathroom!",
 * 25 characters) and how they break a long one is unknown.
 * TODO(open-decision): the creator's longest line and how they split one.
 */
export const SUBTITLE_MAX_CHARS = 42;
/**
 * How long a line stays after its last word. Measured on the creator's videos
 * (Oct 12, 2026): lines go off 0.18 s of source time after playback resumes
 * from a freeze placed just after the speech, about 0.3 s after the last word.
 */
export const SUBTITLE_TAIL_SEC = 0.3;
/** A line is up at least this long, unless the next one starts first. */
export const SUBTITLE_MIN_SEC = 0.8;
/** A gap shorter than this between lines is closed, so the text does not flicker off and on. */
const BRIDGE_SEC = 0.25;
/**
 * A line on screen for less than this (usually a word the transcriber timed
 * badly, split from its sentence) joins the line before it when that one
 * leaves its sentence unfinished.
 */
const FOLD_SEC = 0.3;

const SENTENCE_END = /[.?!…]["'”’)\]]*$/;
const CLAUSE_END = /([,;:]|--|—)["'”’)\]]*$/;
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;
/** Sound tags the transcriber may leave in the words, e.g. "(laughs)". */
const SOUND_TAG = /^[([].*[)\]]$/;

/** Joins words into a line; punctuation-only tokens ("...") attach to the word before and are dropped at the start. */
function lineText(words: readonly Word[]): string {
  let text = '';
  for (const w of words) {
    const t = w.text.trim();
    if (!t) continue;
    if (PUNCTUATION_ONLY.test(t)) text += text ? t : '';
    else text += (text ? ' ' : '') + t;
  }
  return text;
}

/**
 * Splits a sentence into lines that fit: at the most even clause break (a
 * comma, a dash) where both halves fit, else at the most even word break.
 */
function fit(words: Word[]): Word[][] {
  if (words.length < 2 || lineText(words).length <= SUBTITLE_MAX_CHARS) return [words];
  const breaks = Array.from({ length: words.length - 1 }, (_, i) => {
    const k = i + 1;
    const left = lineText(words.slice(0, k)).length;
    const right = lineText(words.slice(k)).length;
    const clause = CLAUSE_END.test(words[k - 1]!.text) && Math.max(left, right) <= SUBTITLE_MAX_CHARS;
    return { k, clause, diff: Math.abs(left - right) };
  });
  const pool = breaks.some((b) => b.clause) ? breaks.filter((b) => b.clause) : breaks;
  const best = pool.reduce((a, b) => (b.diff < a.diff ? b : a));
  return [...fit(words.slice(0, best.k)), ...fit(words.slice(best.k))];
}

/**
 * Subtitles from the transcript: one sentence per line, long sentences split,
 * each line up from its first word to `SUBTITLE_TAIL_SEC` after its last.
 */
export function subtitlesFromTranscript(transcript: Pick<Transcript, 'words' | 'utterances'> | undefined): Subtitle[] {
  if (!transcript) return [];
  const lines: { id: string; words: Word[] }[] = [];
  for (const u of transcript.utterances) {
    const words = transcript.words.slice(u.wordRange[0], u.wordRange[1] + 1).filter((w) => !SOUND_TAG.test(w.text.trim()));
    let sentence: Word[] = [];
    let n = 0;
    const flush = () => {
      for (const line of fit(sentence)) if (lineText(line)) lines.push({ id: `${u.id}-${++n}`, words: line });
      sentence = [];
    };
    for (const w of words) {
      sentence.push(w);
      if (SENTENCE_END.test(w.text.trim())) flush();
    }
    flush();
  }

  const timed = lines
    .map(({ id, words }) => {
      const spoken = words.filter((w) => !PUNCTUATION_ONLY.test(w.text.trim()));
      return { id, text: lineText(words), start: spoken[0]!.start, end: spoken.at(-1)!.end + SUBTITLE_TAIL_SEC };
    })
    .sort((a, b) => a.start - b.start);
  const shown = timed.map((line, i) => {
    const next = timed[i + 1];
    let end = Math.max(line.end, line.start + SUBTITLE_MIN_SEC);
    if (next && next.start - end < BRIDGE_SEC) end = next.start;
    return { ...line, end: Math.round(end * 1000) / 1000 };
  });
  const out: Subtitle[] = [];
  for (const line of shown) {
    const prev = out.at(-1);
    if (line.end - line.start < FOLD_SEC && prev && !SENTENCE_END.test(prev.text) && (prev.text + ' ' + line.text).length <= SUBTITLE_MAX_CHARS) {
      prev.text += ' ' + line.text;
    } else if (line.end > line.start) {
      out.push(line);
    }
  }
  return out;
}

/** The line on screen at a source time, if any. */
export const subtitleAt = (subtitles: readonly Subtitle[], sec: number): Subtitle | undefined =>
  subtitles.find((s) => s.start <= sec && sec < s.end);
