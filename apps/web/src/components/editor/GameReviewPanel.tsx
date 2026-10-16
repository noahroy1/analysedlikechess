import { DEFAULT_ACCURACY, gameResult, reviewSummary } from '@als/schema';
import { barPlayers } from '@als/composition';
import { useRef, useState } from 'react';
import { useEditor, useEditorStore, usePlayback } from '../../editor/context.tsx';
import { setReviewAccuracy, setReviewSummary } from '../../editor/doc.ts';
import { Field } from './fields.tsx';

const SUMMARY_CAP = 160;

/** With nothing selected: the closing game review's accuracy per side and its summary line. */
export function GameReviewPanel() {
  const store = useEditorStore();
  const doc = useEditor((s) => s.doc);
  const theme = useEditor((s) => s.theme);
  const { timeline, seek, pause } = usePlayback();
  const players = barPlayers(doc.characters, doc.moments);
  const summary = doc.gameReview?.summary ?? '';
  const written = reviewSummary(gameResult(doc.evalBar, doc.moments, doc.characters), { white: players.white?.name, black: players.black?.name });
  const span = timeline.gameReview;

  return (
    <div className="space-y-3 rounded-md border border-neutral-800 p-3 text-sm" data-testid="game-review-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-neutral-100">Game review</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {span ? `After the last frame, for ${(span.frames / timeline.fps).toFixed(1)} s.` : `The ${theme.name} look has no game review; the Creator look does.`}
          </p>
        </div>
        {span && (
          <button
            type="button"
            onClick={() => {
              pause();
              seek(span.outStart);
            }}
            className="shrink-0 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Show
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {(['white', 'black'] as const).map((side) => (
          <Field key={side} label={`Accuracy · ${side === 'white' ? 'White' : 'Black'}`}>
            <AccuracyInput
              value={doc.gameReview?.accuracy?.[side]}
              onCommit={(value) => store.getState().edit((d) => setReviewAccuracy(d, side, value))}
              testId={`review-accuracy-${side}`}
            />
            <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{players[side]?.name ?? 'Nobody on this side'}</span>
          </Field>
        ))}
      </div>
      <Field label="Summary" count={[summary.length, SUMMARY_CAP]}>
        <textarea
          value={summary}
          placeholder={written}
          maxLength={SUMMARY_CAP}
          rows={3}
          data-testid="review-summary"
          onChange={(e) => store.getState().edit((d) => setReviewSummary(d, e.target.value), { coalesce: 'gameReview.summary' })}
          className="input resize-y text-xs"
        />
        <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">Blank writes it from the bar: who it favours at the end, and from where.</span>
      </Field>
    </div>
  );
}

/** 0-100; commits on Enter or blur, and empty goes back to the default. */
function AccuracyInput({ value, onCommit, testId }: { value: number | undefined; onCommit: (value: number | undefined) => void; testId: string }) {
  const cancelled = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null || draft.trim() === '' ? undefined : Number(draft);
  const invalid = parsed !== undefined && !(Number.isFinite(parsed) && parsed >= 0 && parsed <= 100);
  const commit = () => {
    // Esc blurs too, and this closure still holds the draft it cancels.
    if (!cancelled.current && draft !== null && !invalid) onCommit(parsed);
    cancelled.current = false;
    setDraft(null);
  };
  return (
    <input
      value={draft ?? (value === undefined ? '' : value.toFixed(1))}
      placeholder={DEFAULT_ACCURACY.toFixed(1)}
      inputMode="decimal"
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      className={`input tabular-nums ${invalid ? 'border-red-700 text-red-300' : ''}`}
    />
  );
}
