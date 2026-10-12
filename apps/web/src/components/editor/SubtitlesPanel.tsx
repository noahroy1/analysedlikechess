import { sourceFrameToOut, timeMapFrame } from '@als/composition';
import { useMemo } from 'react';
import { deleteSubtitle, followTranscript, retimeSubtitle, setSubtitleText, subtitlesOf } from '../../editor/doc.ts';
import { useEditor, useEditorStore, usePlayback } from '../../editor/context.tsx';
import { formatTime } from '../../lib/format.ts';
import { SecondsInput } from './fields.tsx';

/** Fix the burned-in subtitles: their text and timing. Until the first edit they follow the transcript. */
export function SubtitlesPanel() {
  const store = useEditorStore();
  const transcript = useEditor((s) => s.project.transcript);
  const editedSubtitles = useEditor((s) => s.doc.subtitles);
  const edited = editedSubtitles !== undefined;
  const subtitles = useMemo(() => subtitlesOf({ subtitles: editedSubtitles }, transcript), [editedSubtitles, transcript]);
  const hasStyle = useEditor((s) => s.theme.subtitles !== undefined);
  const { fps, timeline, frame, seek, pause } = usePlayback();
  const edit = store.getState().edit;
  const sourceSec = timeMapFrame(timeline, frame).sourceFrame / fps;

  const goTo = (sec: number) => {
    pause();
    seek(sourceFrameToOut(timeline, Math.ceil(sec * fps)));
  };

  return (
    <div className="space-y-3 text-sm" data-testid="subtitles-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-neutral-400">
          {subtitles.length} lines · {edited ? 'edited' : 'following the transcript'}
        </p>
        {edited && (
          <button
            type="button"
            data-testid="follow-transcript"
            onClick={() => edit(followTranscript)}
            title="Drop every subtitle edit and build the lines from the transcript again"
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500"
          >
            Rebuild from transcript
          </button>
        )}
      </div>
      {!hasStyle && <p className="text-xs text-amber-300/90">This look draws no subtitles.</p>}
      {!transcript && <p className="text-xs text-neutral-500">No transcript yet: subtitles appear once analysis has transcribed the clip.</p>}

      <ul className="space-y-1.5">
        {subtitles.map((s) => {
          const live = s.start <= sourceSec && sourceSec < s.end;
          return (
            <li
              key={s.id}
              data-subtitle-id={s.id}
              data-live={live || undefined}
              className={`rounded-md border p-1.5 ${live ? 'border-sky-500/70 bg-sky-500/5' : 'border-neutral-800'}`}
            >
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-neutral-400">
                <button type="button" onClick={() => goTo(s.start)} title="Show this line in the player" className="tabular-nums hover:text-sky-300">
                  {formatTime(s.start)}
                </button>
                <span className="w-16">
                  <SecondsInput value={s.start} fps={fps} onCommit={(sec) => edit((d) => retimeSubtitle(d, transcript, s.id, 'start', sec))} />
                </span>
                <span>to</span>
                <span className="w-16">
                  <SecondsInput value={s.end} fps={fps} onCommit={(sec) => edit((d) => retimeSubtitle(d, transcript, s.id, 'end', sec))} />
                </span>
                <button
                  type="button"
                  aria-label="Delete subtitle"
                  title="Delete this line"
                  onClick={() => edit((d) => deleteSubtitle(d, transcript, s.id))}
                  className="ml-auto rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-300"
                >
                  ×
                </button>
              </div>
              <input
                value={s.text}
                aria-label="Subtitle text"
                onFocus={() => goTo(s.start)}
                onChange={(e) => edit((d) => setSubtitleText(d, transcript, s.id, e.target.value), { coalesce: `${s.id}.subtitle` })}
                className="input w-full py-1"
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
