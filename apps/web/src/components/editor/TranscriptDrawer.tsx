import { freezeAfterSpeech } from '@als/schema';
import { sourceFrameToOut, timeMapFrame } from '@als/composition';
import { useCallback, useState } from 'react';
import { EditError, addMoment } from '../../editor/doc.ts';
import { useEditor, useEditorStore, usePlayback } from '../../editor/context.tsx';
import { draftNewMove } from '../../editor/regenerate.ts';
import { formatTime } from '../../lib/format.ts';
import { speakerColor } from './speakers.ts';

/** Click a line to seek; select words to make a move where they end. */
export function TranscriptDrawer() {
  const store = useEditorStore();
  const project = useEditor((s) => s.project);
  const characters = useEditor((s) => s.doc.characters);
  const { fps, timeline, frame, seek, pause, goToMoment } = usePlayback();
  const [open, setOpen] = useState(true);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const transcript = project.transcript;
  const sourceSec = timeMapFrame(timeline, frame).sourceFrame / fps;
  const speakers = [...new Set(transcript?.utterances.map((u) => u.speaker) ?? [])];
  const nameOf = (label: string) => characters.find((c) => c.speakerLabels.includes(label))?.name ?? `Speaker ${label}`;

  const readSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return setSelection(null);
    const indexOf = (node: Node | null) => {
      const el = node instanceof Element ? node : node?.parentElement;
      const word = el?.closest('[data-word]');
      return word ? Number(word.getAttribute('data-word')) : undefined;
    };
    const a = indexOf(sel.anchorNode);
    const b = indexOf(sel.focusNode);
    setSelection(a === undefined || b === undefined ? null : [Math.min(a, b), Math.max(a, b)]);
  }, []);

  const makeMove = () => {
    if (!transcript || !selection) return;
    const words = transcript.words;
    const last = words[selection[1]]!;
    const sourceTime = freezeAfterSpeech(last.end, project.shots ?? [], fps);
    const utteranceIds = transcript.utterances
      .filter((u) => u.wordRange[1] >= selection[0] && u.wordRange[0] <= selection[1])
      .map((u) => u.id);
    const actorId = characters.find((c) => c.speakerLabels.includes(last.speaker))?.id;
    try {
      let id = '';
      store.getState().edit((d) => {
        const added = addMoment(d, { sourceTime, utteranceIds, ...(actorId ? { actorId } : {}) }, store.getState().theme, project.source.durationSec);
        id = added.id;
        return added.doc;
      });
      store.getState().select(id);
      // Pass B drafts its text; the card fills in when it arrives.
      void draftNewMove(store, id);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      requestAnimationFrame(() => {
        goToMoment(id);
        store.getState().requestFocus(id, 'moveLabel');
      });
    } catch (error) {
      if (error instanceof EditError) store.getState().notify(error.message, 'warn');
      else throw error;
    }
  };

  return (
    <section className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900/60" data-testid="transcript">
      <header className="flex items-center gap-3 px-3 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs font-medium tracking-wide text-neutral-400 uppercase hover:text-neutral-200">
          {open ? '▾' : '▸'} Transcript
        </button>
        {selection && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={makeMove}
            className="rounded-md bg-sky-500 px-2 py-0.5 text-xs font-medium text-neutral-950 hover:bg-sky-400"
            data-testid="make-move"
          >
            Make this a move ({selection[1] - selection[0] + 1} word{selection[0] === selection[1] ? '' : 's'})
          </button>
        )}
      </header>
      {open &&
        (!transcript ? (
          <p className="px-3 pb-3 text-xs text-neutral-500">No transcript yet. It arrives with analysis.</p>
        ) : (
          <ol className="max-h-56 overflow-y-auto px-3 pb-3 text-sm leading-relaxed" onMouseUp={readSelection} onKeyUp={readSelection}>
            {transcript.utterances.map((u) => {
              const current = sourceSec >= u.start && sourceSec <= u.end + 0.15;
              const words = transcript.words.slice(u.wordRange[0], u.wordRange[1] + 1);
              return (
                <li key={u.id} className={`flex gap-3 rounded px-1 py-0.5 ${current ? 'bg-neutral-800/70' : ''}`}>
                  <button
                    type="button"
                    onClick={() => {
                      pause();
                      seek(sourceFrameToOut(timeline, Math.round(u.start * fps)));
                    }}
                    className="w-12 shrink-0 text-left text-xs text-neutral-500 tabular-nums select-none hover:text-neutral-200"
                  >
                    {formatTime(u.start)}
                  </button>
                  <span className="w-20 shrink-0 truncate text-xs font-medium select-none" style={{ color: speakerColor(speakers, u.speaker) }}>
                    {nameOf(u.speaker)}
                  </span>
                  <span className="text-neutral-200">
                    {words.map((w) => (
                      <span key={w.i} data-word={w.i}>
                        {w.text}{' '}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ol>
        ))}
    </section>
  );
}
