import { evalWarnings, formatEvalSigned, parseEval, type Eval, type EvalBeat } from '@als/schema';
import { sourceFrameToOut, timeMapFrame } from '@als/composition';
import { useState, type ReactNode } from 'react';
import { addBeatAt, reevaluateBar } from '../../editor/bar.ts';
import { useEditor, useEditorStore, usePlayback } from '../../editor/context.tsx';
import { deleteBeat, setStartEval, updateBeat } from '../../editor/doc.ts';
import { formatTime } from '../../lib/format.ts';
import { Field, SecondsInput } from './fields.tsx';

/**
 * An eval as typed: "1.0", "-0.8", "M4" (White mates), "-M6" (Black mates).
 * Commits on Enter or blur; empty commits undefined where `optional`.
 */
export function EvalInput({
  value,
  optional = false,
  placeholder,
  onCommit,
  testId,
}: {
  value: Eval | undefined;
  optional?: boolean;
  placeholder?: string;
  onCommit: (value: Eval | undefined) => void;
  testId?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? formatEvalSigned(value) : '');
  const parsed = draft === null ? value : draft.trim() === '' ? undefined : parseEval(draft);
  const invalid = draft !== null && draft.trim() !== '' && parsed === undefined;
  const commit = () => {
    if (draft !== null && !invalid && (optional || parsed)) onCommit(parsed);
    setDraft(null);
  };
  return (
    <input
      value={shown}
      placeholder={placeholder}
      inputMode="decimal"
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className={`input tabular-nums ${invalid ? 'border-red-700 text-red-300' : ''}`}
    />
  );
}

export const EVAL_HINT = 'Pawns for White (1.0, -0.8) or a mate: M4 White mates, -M6 Black mates.';

/** The selected beat: a change of the bar during play, with no card. */
export function BeatInspector({ beat }: { beat: EvalBeat }) {
  const store = useEditorStore();
  const doc = useEditor((s) => s.doc);
  const durationSec = useEditor((s) => s.project.source.durationSec);
  const { fps, timeline, seek, pause } = usePlayback();
  const set = (patch: Partial<Omit<EvalBeat, 'id'>>, coalesce?: string) =>
    store.getState().edit((d) => updateBeat(d, beat.id, patch, durationSec), coalesce ? { coalesce: `${beat.id}.${coalesce}` } : undefined);
  const warnings = evalWarnings(doc.evalBar, doc.moments, doc.characters, doc.format).get(beat.id) ?? [];

  return (
    <div className="space-y-4 text-sm" data-testid="beat-inspector">
      <div>
        <h3 className="text-sm font-semibold text-neutral-100">Beat</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
          The bar moves here while the video plays, with no card. Beats are the decisions the Analyst found but did not rate.
        </p>
      </div>

      <Field label="Bar after the beat">
        <EvalInput value={beat.eval} onCommit={(value) => value && set({ eval: value })} testId="beat-eval" />
        <Hint>{EVAL_HINT}</Hint>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="At">
          <SecondsInput value={beat.sourceTime} fps={fps} onCommit={(sourceTime) => set({ sourceTime })} />
          <button
            type="button"
            className="mt-0.5 text-[11px] text-sky-400 hover:underline"
            onClick={() => {
              pause();
              seek(sourceFrameToOut(timeline, Math.round(beat.sourceTime * fps)));
            }}
          >
            Go to {formatTime(beat.sourceTime)}
          </button>
        </Field>
        <Field label="Who">
          <select
            value={beat.actorId ?? ''}
            onChange={(e) => set({ actorId: e.target.value || undefined })}
            className="input"
          >
            <option value="">Nobody in particular</option>
            {doc.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || 'Unnamed'}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="What happened">
        <textarea
          value={beat.action ?? ''}
          onChange={(e) => set({ action: e.target.value || undefined }, 'action')}
          rows={2}
          className="input resize-y text-xs"
        />
      </Field>
      <Field label="Why the bar moves">
        <textarea
          value={beat.reason ?? ''}
          onChange={(e) => set({ reason: e.target.value || undefined }, 'reason')}
          rows={2}
          className="input resize-y text-xs"
        />
      </Field>

      <Warnings messages={warnings} />

      <p className="text-xs text-neutral-500">{beat.origin === 'ai' ? 'Placed by AI' : 'Added by you'}</p>
      <button
        type="button"
        onClick={() => {
          store.getState().edit((d) => deleteBeat(d, beat.id));
          store.getState().select(null);
          store.getState().notify('Beat deleted. Undo with ⌘Z / Ctrl+Z.');
        }}
        className="w-full rounded-md border border-neutral-800 py-1.5 text-xs text-neutral-400 hover:border-red-900 hover:text-red-300"
      >
        Delete beat
      </button>
    </div>
  );
}

/** With nothing selected: the bar's start, its beats, and Re-evaluate. */
export function BarPanel() {
  const store = useEditorStore();
  const doc = useEditor((s) => s.doc);
  const theme = useEditor((s) => s.theme);
  const { timeline, frame, fps } = usePlayback();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const warnings = [...evalWarnings(doc.evalBar, doc.moments, doc.characters, doc.format).values()].flat().length;
  const valued = doc.moments.filter((m) => m.eval).length;
  const beats = doc.evalBar?.beats.length ?? 0;

  return (
    <div className="space-y-3 rounded-md border border-neutral-800 p-3 text-sm" data-testid="bar-panel">
      <div>
        <h3 className="text-sm font-semibold text-neutral-100">Evaluation bar</h3>
        <p className="mt-0.5 text-xs text-neutral-500 tabular-nums">
          {doc.evalBar ? `${valued} of ${doc.moments.length} moves valued · ${beats} beat${beats === 1 ? '' : 's'}` : 'Not valued yet.'}
          {warnings > 0 && <span className="text-amber-300"> · {warnings} to check</span>}
        </p>
        {!theme.evalBar && <p className="mt-1 text-xs text-neutral-500">The {theme.name} look does not draw the bar; the Creator look does.</p>}
      </div>
      <Field label="Start of the scene">
        <EvalInput value={doc.evalBar?.start} onCommit={(value) => value && store.getState().edit((d) => setStartEval(d, value))} testId="start-eval" />
        <Hint>{EVAL_HINT}</Hint>
      </Field>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => addBeatAt(store, timeMapFrame(timeline, frame).sourceFrame / fps)}
          className="flex-1 rounded-md border border-neutral-700 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
          title="Add a beat at the playhead (B)"
        >
          Add beat here
        </button>
        <button
          type="button"
          disabled={busy || doc.moments.length === 0}
          data-testid="reevaluate"
          onClick={() => {
            setBusy(true);
            setError(null);
            reevaluateBar(store)
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
          className="flex-1 rounded-md bg-sky-700 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          title="Value every move and beat again, together (Pass C)"
        >
          {busy ? 'Evaluating…' : doc.evalBar ? 'Re-evaluate' : 'Evaluate'}
        </button>
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}

export function Warnings({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="rounded-md border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-xs text-amber-300">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

const Hint = ({ children }: { children: ReactNode }) => <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">{children}</span>;
