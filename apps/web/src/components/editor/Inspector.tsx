import { CARD_ANCHORS, NO_BEST_MOVE, autoHoldSec, textCaps, evalWarnings, momentWarnings, placedByHand, regionsFresh, type Card, type Moment } from '@als/schema';
import { sourceFrameToOut } from '@als/composition';
import { useState, type ReactNode } from 'react';
import { deleteMoment, evalBeforeItem, retime, setCardByHand, setMomentEval, updateMoment } from '../../editor/doc.ts';
import { reevaluatePlacement } from '../../editor/placement.ts';
import { useEditor, useEditorStore, usePlayback } from '../../editor/context.tsx';
import { formatTime } from '../../lib/format.ts';
import { BarPanel, BeatInspector, EVAL_HINT, EvalInput, Warnings } from './BarPanels.tsx';
import { ClassificationPicker } from './ClassificationPicker.tsx';
import { Field, SecondsInput } from './fields.tsx';
import { GameReviewPanel } from './GameReviewPanel.tsx';
import { RegeneratePanel } from './RegeneratePanel.tsx';

const ANCHOR_LABELS: Record<Moment['card']['anchor'], string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
  custom: 'Custom (dragged)',
};

/** Every field of the selected moment or beat; with nothing selected, the evaluation bar and the game review. */
export function Inspector() {
  const store = useEditorStore();
  const selectedId = useEditor((s) => s.selectedId);
  const moment = useEditor((s) => s.doc.moments.find((m) => m.id === s.selectedId));
  const beat = useEditor((s) => s.doc.evalBar?.beats.find((b) => b.id === s.selectedId));
  const doc = useEditor((s) => s.doc);
  const characters = doc.characters;
  const theme = useEditor((s) => s.theme);
  const project = useEditor((s) => s.project);
  const { fps, timeline, seek, pause } = usePlayback();

  if (beat) return <BeatInspector key={beat.id} beat={beat} />;
  if (!selectedId || !moment) {
    return (
      <div className="space-y-4">
        <p className="px-1 pt-6 text-center text-xs leading-relaxed text-neutral-500">
          Select a move on the timeline or in the list.
          <br />
          Press <Kbd>M</Kbd> to add one at the playhead, <Kbd>B</Kbd> for a beat.
        </p>
        <BarPanel />
        <GameReviewPanel />
      </div>
    );
  }

  const set = (patch: Partial<Moment>, coalesce?: string) =>
    store.getState().edit((d) => updateMoment(d, moment.id, patch), coalesce ? { coalesce: `${moment.id}.${coalesce}` } : undefined);
  const setCard = (card: Card, coalesce?: string) =>
    store.getState().edit((d) => setCardByHand(d, moment.id, card), coalesce ? { coalesce: `${moment.id}.${coalesce}` } : undefined);
  const utterances = project.transcript?.utterances ?? [];
  const evidence = moment.evidence.utteranceIds.map((id) => utterances.find((u) => u.id === id)).filter((u) => u !== undefined);
  const speakerName = (label: string) => characters.find((c) => c.speakerLabels.includes(label))?.name ?? `Speaker ${label}`;
  const warnings = momentWarnings(moment, doc.format);
  const barWarnings = evalWarnings(doc.evalBar, doc.moments, characters, doc.format).get(moment.id) ?? [];
  const autoHold = autoHoldSec(moment, theme.timing, doc.format);
  const caps = textCaps(doc.format);

  return (
    <div className="space-y-4 text-sm" data-testid="inspector">
      <RegeneratePanel key={moment.id} momentId={moment.id} />

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

      <Field label="Label" count={[moment.moveLabel.length, caps.moveLabel]}>
        <input value={moment.moveLabel} onChange={(e) => set({ moveLabel: e.target.value }, 'moveLabel')} className="input" />
      </Field>

      <Field label="Breakdown" count={[moment.explanation.length, caps.explanation]}>
        <textarea
          value={moment.explanation}
          onChange={(e) => set({ explanation: e.target.value.replace(/\n/g, ' ') }, 'explanation')}
          rows={5}
          className="input resize-y"
        />
      </Field>

      {NO_BEST_MOVE.has(moment.classification) ? (
        <p className="text-xs text-neutral-500">
          {theme.classifications[moment.classification].label} moves have no best move.
        </p>
      ) : (
        <Field label="Best move" count={[moment.bestMove?.length ?? 0, caps.bestMove]}>
          <textarea
            value={moment.bestMove ?? ''}
            onChange={(e) => set({ bestMove: e.target.value ? e.target.value.replace(/\n/g, ' ') : undefined }, 'bestMove')}
            rows={2}
            className="input resize-y"
          />
        </Field>
      )}

      <Field label="Motif" count={[moment.motif?.length ?? 0, caps.motif]}>
        <input
          value={moment.motif ?? ''}
          placeholder="Sacrifice, Zwischenzug, Quiet Move…"
          onChange={(e) => set({ motif: e.target.value || undefined }, 'motif')}
          className="input"
        />
      </Field>

      <Field label="Bar after this move">
        <EvalInput
          value={moment.eval}
          before={evalBeforeItem(doc, moment.id, moment.sourceTime)}
          optional
          onCommit={(value) => store.getState().edit((d) => setMomentEval(d, moment.id, value))}
          testId="moment-eval"
        />
        <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">{EVAL_HINT}</span>
      </Field>

      <Warnings messages={[...warnings.map((w) => w.message), ...barWarnings]} />

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
              const { x, y, scale } = moment.card;
              setCard(anchor === 'custom' ? { anchor, x: x ?? 0.05, y: y ?? 0.4, scale } : { anchor, scale });
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
            onChange={(e) => setCard({ ...moment.card, scale: Number(e.target.value) }, 'scale')}
            className="mt-2 w-full accent-sky-400"
          />
        </Field>
      </div>

      <PlacementStatus moment={moment} />

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

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-neutral-700 bg-neutral-800 px-1 font-sans text-[10px] text-neutral-300">{children}</kbd>;
}

/** How the card got where it is, and Re-evaluate: place it clear of faces now. */
function PlacementStatus({ moment }: { moment: Moment }) {
  const store = useEditorStore();
  const [busy, setBusy] = useState(false);
  const auto = moment.card.placement === 'auto';
  const text = placedByHand(moment.card)
    ? 'Placed by you. Retiming keeps it here.'
    : auto && regionsFresh(moment)
      ? 'Placed clear of faces. Follows the move if it is retimed.'
      : auto
        ? 'Finding faces on this frame…'
        : 'In the look\'s corner.';
  return (
    <div className="-mt-1 flex items-center justify-between gap-2 text-[11px] text-neutral-500" data-testid="placement-status">
      <span>{text}</span>
      <button
        type="button"
        disabled={busy}
        data-testid="reevaluate-placement"
        title="Place this card clear of the faces on its frame, replacing any position or size set by hand"
        onClick={() => {
          setBusy(true);
          void reevaluatePlacement(store, moment.id).finally(() => setBusy(false));
        }}
        className="shrink-0 rounded border border-neutral-700 px-2 py-0.5 text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
      >
        {busy ? 'Looking…' : 'Re-evaluate'}
      </button>
    </div>
  );
}
