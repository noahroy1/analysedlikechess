import type { Transcript } from '@als/schema';
import { describe, expect, it } from 'vitest';
import { EditError, MIN_SUBTITLE_SEC, deleteSubtitle, followTranscript, retimeSubtitle, setSubtitleText, subtitlesOf, type Doc } from './doc.ts';

const transcript: Transcript = {
  words: [
    { i: 0, text: 'Step', start: 2, end: 2.2, speaker: 'A' },
    { i: 1, text: 'out!', start: 2.3, end: 2.5, speaker: 'A' },
    { i: 2, text: 'Now.', start: 5, end: 5.3, speaker: 'B' },
  ],
  utterances: [
    { id: 'u1', speaker: 'A', start: 2, end: 2.5, text: 'Step out!', wordRange: [0, 1] },
    { id: 'u2', speaker: 'B', start: 5, end: 5.3, text: 'Now.', wordRange: [2, 2] },
  ],
};
const doc: Doc = { moments: [], characters: [], themeId: 'creator', format: 'long' };

describe('subtitle edits', () => {
  it('follow the transcript until the first edit, which keeps every line', () => {
    expect(subtitlesOf(doc, transcript).map((s) => s.text)).toEqual(['Step out!', 'Now.']);
    const edited = setSubtitleText(doc, transcript, 'u1-1', 'Step out of the bathroom!');
    expect(edited.subtitles?.map((s) => s.text)).toEqual(['Step out of the bathroom!', 'Now.']);
  });

  it('delete a line, and Rebuild brings the transcript back', () => {
    const edited = deleteSubtitle(doc, transcript, 'u2-1');
    expect(subtitlesOf(edited, transcript).map((s) => s.id)).toEqual(['u1-1']);
    expect(subtitlesOf(followTranscript(edited), transcript)).toHaveLength(2);
  });

  it('retime a line, never shorter than the minimum', () => {
    const later = retimeSubtitle(doc, transcript, 'u1-1', 'start', 2.1);
    expect(later.subtitles![0]!.start).toBe(2.1);
    const squashed = retimeSubtitle(doc, transcript, 'u1-1', 'end', 0);
    expect(squashed.subtitles![0]!.end).toBeCloseTo(2 + MIN_SUBTITLE_SEC);
  });

  it('refuse a line that no longer exists', () => {
    expect(() => setSubtitleText(doc, transcript, 'gone', 'x')).toThrow(EditError);
  });
});
