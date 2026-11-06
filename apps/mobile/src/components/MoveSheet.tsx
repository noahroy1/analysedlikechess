import { deleteMoment, setClassification, setStatus, updateMoment } from '@als/editor-core';
import { CLASSIFICATIONS, NO_BEST_MOVE, momentWarnings, type Moment } from '@als/schema';
import { Badge } from '@als/theme';
import { useEditor, useEditorStore } from './Editor.tsx';

/**
 * Light edits to one card over the paused hold: rating, the three texts, approve, delete. Each change
 * is an undo step (typing coalesces) and autosaves; the Player above shows it at once.
 */
export function MoveSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const store = useEditorStore();
  const moment = useEditor((s) => s.doc.moments.find((m) => m.id === id));
  const theme = useEditor((s) => s.theme);
  const format = useEditor((s) => s.doc.format);
  if (!moment) return null;

  const set = (patch: Partial<Moment>, field: string) => store.getState().edit((d) => updateMoment(d, id, patch), { coalesce: `${id}.${field}` });
  const warnings = momentWarnings(moment, format);
  const approved = moment.status === 'approved';

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 max-h-[48dvh] overflow-y-auto rounded-t-2xl border-t border-neutral-700 bg-neutral-950 px-4 pt-3 shadow-2xl safe-bottom" data-testid="move-sheet">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Edit card</h2>
        <button type="button" className="btn-quiet px-2" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="mt-2 grid grid-cols-5 gap-1" role="listbox" aria-label="Rating">
        {CLASSIFICATIONS.map((c) => {
          const style = theme.classifications[c];
          const selected = c === moment.classification;
          return (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => store.getState().edit((d) => setClassification(d, id, c))}
              className={`flex flex-col items-center gap-1 rounded-lg py-1.5 text-[10px] ${selected ? 'bg-neutral-700 text-neutral-50' : 'text-neutral-400'}`}
            >
              <Badge badge={style.badge} color={style.color} size={24} />
              {style.label}
            </button>
          );
        })}
      </div>

      <label className="mt-3 block text-xs text-neutral-400">
        Move
        <input value={moment.moveLabel} onChange={(e) => set({ moveLabel: e.target.value }, 'moveLabel')} className="field mt-1" data-testid="move-label" />
      </label>
      <label className="mt-3 block text-xs text-neutral-400">
        Breakdown
        <textarea value={moment.explanation} onChange={(e) => set({ explanation: e.target.value }, 'explanation')} rows={4} className="field mt-1 resize-none" data-testid="move-explanation" />
      </label>
      {!NO_BEST_MOVE.has(moment.classification) && (
        <label className="mt-3 block text-xs text-neutral-400">
          Better was
          <input value={moment.bestMove ?? ''} onChange={(e) => set({ bestMove: e.target.value }, 'bestMove')} className="field mt-1" />
        </label>
      )}
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-amber-300">
          {warnings.map((w) => (
            <li key={`${w.field}:${w.message}`}>{w.message}</li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex gap-2 pb-1">
        <button type="button" className={approved ? 'btn flex-1' : 'btn-primary flex-1'} onClick={() => store.getState().edit((d) => setStatus(d, [id], approved ? 'draft' : 'approved'))} data-testid="approve">
          {approved ? 'Approved ✓ (undo)' : 'Approve'}
        </button>
        <button
          type="button"
          className="btn border-red-900 text-red-300"
          onClick={() => {
            if (!window.confirm('Delete this move?')) return;
            store.getState().edit((d) => deleteMoment(d, id));
            store.getState().select(null);
            onClose();
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
