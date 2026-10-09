import { CARD_ANCHORS, NO_BEST_MOVE, TEXT_CAPS, autoHoldSec, momentWarnings, type Moment } from '@als/schema';
import { sourceFrameToOut } from '@als/composition';
import { useState, type ReactNode } from 'react';
import { deleteMoment, retime, updateMoment } from '../../editor/doc.ts';
import { useEditor, useEditorStore, usePlayback } from '../../editor/context.tsx';
import { formatTime } from '../../lib/format.ts';
import { ClassificationPicker } from './ClassificationPicker.tsx';

const ANCHOR_LABELS: Record<Moment['card']['anchor'], string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
  custom: 'Custom (dragged)',
};

/** Every field of the selected moment. */
export function Inspector() {
  const store = useEditorStore();
  const selectedId = useEditor((s) => s.selectedId);
  const moment = useEditor((s) => s.doc.moments.find((m) => m.id === s.selectedId));
  const characters = useEditor((s) => s.doc.characters);
  const theme = useEditor((s) => s.theme);
  const project = useEditor((s) => s.project);
  const { fps, timeline, seek, pause } = usePlayback();

  if (!selectedId || !moment) {
    return (
      <p className="px-1 py-6 text-center text-xs leading-relaxed text-neutral-500">
        Select a move on the timeline or in the list.
        <br />
        Press <Kbd>M</Kbd> to add one at the playhead.
      </p>
    );
  }

  const set = (patch: Partial<Moment>, coalesce?: string) =>
    store.getState().edit((d) => updateMoment(d, moment.id, patch), coalesce ? { coalesce: `${moment.id}.${coalesce}` } : undefined);
  const utterances = project.transcript?.utterances ?? [];
  const evidence = moment.evidence.utteranceIds.map((id) => utterances.find((u) => u.id === id)).filter((u) => u !== undefined);
  const speakerName = (label: string) => characters.find((c) => c.speakerLabels.includes(label))?.name ?? `Speaker ${label}`;
  const warnings = momentWarnings(moment);
  const autoHold = autoHoldSec(moment, theme.timing);

  return (
    <div className="space-y-4 text-sm" data-testid="inspector">
      <Field label="Rating">
        <ClassificationPicker theme={theme} value={moment.classification} onPick={(classification) => set({ classification })} />
      </Field>

      <Field label="Who made the move">
        <select
          value={moment.actorId ?? ''}
          onChange={(e) => set(e.target.value ? { actorId: e.target.value } : { actorId: undefined })}
          className="input"
        >
          <option value="">Nobody in particular</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || 'Unnamed'}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Label" count={[moment.moveLabel.length, TEXT_CAPS.moveLabel]}>
        <input value={moment.moveLabel} onChange={(e) => set({ moveLabel: e.target.value }, 'moveLabel')} className="input" />
      </Field>

      <Field label="Breakdown" count={[moment.explanation.length, TEXT_CAPS.explanation]}>
        <textarea
          value={moment.explanation}
          onChange={(e) => set({ explanation: e.target.value.replace(/\n/g, ' ') }, 'explanation')}
          rows={5}
          className="input resize-y"
        />
      </Field>

      <Field
        label="Best move"
        count={[moment.bestMove?.length ?? 0, TEXT_CAPS.bestMove]}
        hint={NO_BEST_MOVE.has(moment.classification) ? 'Usually left empty for this rating.' : undefined}
      >
        <textarea
          value={moment.bestMove ?? ''}
          onChange={(e) => set({ bestMove: e.target.value ? e.target.value.replace(/\n/g, ' ') : undefined }, 'bestMove')}
          rows={2}
          className="input resize-y"
        />
      </Field>

      {warnings.length > 0 && (
        <ul className="rounded-md border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-xs text-amber-300">
          {warnings.map((w) => (
            <li key={w.message}>{w.message}</li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Freezes at">
          <SecondsInput
            value={moment.sourceTime}
            fps={fps}
            onCommit={(sec) => store.getState().edit((d) => retime(d, moment.id, sec, project.source.durationSec))}
          />
          <span className="mt-0.5 block text-[11px] text-neutral-500 tabular-nums">frame {Math.round(moment.sourceTime * fps)}</span>
        </Field>
        <Field label="Hold">
          <SecondsInput
            value={moment.holdSec}
            fps={10}
            min={0.5}
            onCommit={(holdSec) => set({ holdSec, holdLocked: true })}
          />
          <span className="mt-0.5 block text-[11px] text-neutral-500">
            {moment.holdLocked ? (
              <button type="button" className="text-sky-400 hover:underline" onClick={() => set({ holdLocked: undefined, holdSec: autoHold })}>
                Reset to {autoHold.toFixed(1)} s
              </button>
            ) : (
              'Follows the text'
            )}
          </span>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Card position">
          <select
            value={moment.card.anchor}
            onChange={(e) => {
              const anchor = e.target.value as Moment['card']['anchor'];
              set({ card: anchor === 'custom' ? { anchor, x: 0.05, y: 0.4, scale: moment.card.scale } : { anchor, scale: moment.card.scale } });
            }}
            className="input"
          >
            {CARD_ANCHORS.map((a) => (
              <option key={a} value={a}>
                {ANCHOR_LABELS[a]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Card size ${Math.round(moment.card.scale * 100)}%`}>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={moment.card.scale}
            onChange={(e) => set({ card: { ...moment.card, scale: Number(e.target.value) } }, 'scale')}
            className="mt-2 w-full accent-sky-400"
          />
        </Field>
      </div>

      <div className="flex items-center justify-between rounded-md border border-neutral-800 px-2 py-1.5 text-xs">
        <span className="text-neutral-400">
          {moment.origin === 'ai' ? 'Drafted by AI' : 'Added by you'}
          {moment.confidence !== undefined && ` · ${Math.round(moment.confidence * 100)}% confident`}
        </span>
        <button
          type="button"
          onClick={() => set({ status: moment.status === 'approved' ? 'draft' : 'approved' })}
          className={`rounded px-2 py-0.5 ${moment.status === 'approved' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-neutral-800 text-neutral-200'}`}
        >
          {moment.status === 'approved' ? '✓ Approved' : 'Approve'}
        </button>
      </div>

      <Field label="Evidence">
        {evidence.length === 0 && <p className="text-xs text-neutral-500">No dialogue linked.</p>}
        <ul className="space-y-1">
          {evidence.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => {
                  pause();
                  seek(sourceFrameToOut(timeline, Math.round(u.start * fps)));
                }}
                className="w-full rounded px-1.5 py-1 text-left text-xs text-neutral-300 hover:bg-neutral-800"
              >
                <span className="text-neutral-500 tabular-nums">{formatTime(u.start)} </span>
                <span className="font-medium text-neutral-200">{speakerName(u.speaker)}:</span> {u.text}
              </button>
            </li>
          ))}
        </ul>
        <textarea
          value={moment.evidence.note ?? ''}
          placeholder="Note on why this moment"
          onChange={(e) => set({ evidence: { ...moment.evidence, note: e.target.value || undefined } }, 'note')}
          rows={2}
          className="input mt-1.5 resize-y text-xs"
        />
      </Field>

      <button
        type="button"
        onClick={() => {
          store.getState().edit((d) => deleteMoment(d, moment.id));
          store.getState().select(null);
          store.getState().notify('Move deleted. Undo with ⌘Z / Ctrl+Z.');
        }}
        className="w-full rounded-md border border-neutral-800 py-1.5 text-xs text-neutral-400 hover:border-red-900 hover:text-red-300"
      >
        Delete move
      </button>
    </div>
  );
}

function Field({ label, count, hint, children }: { label: string; count?: [number, number]; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-[11px] font-medium tracking-wide text-neutral-400 uppercase">
        {label}
        {count && <span className={`tabular-nums normal-case ${count[0] > count[1] ? 'text-red-400' : 'text-neutral-500'}`}>{count[0]}/{count[1]}</span>}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-neutral-500">{hint}</span>}
    </label>
  );
}

/** A seconds field that commits on Enter or blur, snapped to 1/fps. */
function SecondsInput({ value, fps, min = 0, onCommit }: { value: number; fps: number; min?: number; onCommit: (sec: number) => void }) {
  // What the user is typing; null shows the current value.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const sec = Number(draft);
    if (draft !== null && Number.isFinite(sec) && sec >= min) onCommit(Math.round(sec * fps) / fps);
    setDraft(null);
  };
  return (
    <input
      value={draft ?? value.toFixed(2)}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className="input tabular-nums"
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-neutral-700 bg-neutral-800 px-1 font-sans text-[10px] text-neutral-300">{children}</kbd>;
}
