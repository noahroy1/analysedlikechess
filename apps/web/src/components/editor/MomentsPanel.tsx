import { Badge } from '@als/theme';
import { useState } from 'react';
import { setStatus } from '../../editor/doc.ts';
import { useEditor, useEditorStore, usePlayback } from '../../editor/context.tsx';
import { formatTime } from '../../lib/format.ts';

type Filter = 'all' | 'draft' | 'approved';

/** Every moment in order; click to jump to it. */
export function MomentsPanel() {
  const store = useEditorStore();
  const moments = useEditor((s) => s.doc.moments);
  const characters = useEditor((s) => s.doc.characters);
  const theme = useEditor((s) => s.theme);
  const selectedId = useEditor((s) => s.selectedId);
  const { goToMoment } = usePlayback();
  const [filter, setFilter] = useState<Filter>('all');
  const names = new Map(characters.map((c) => [c.id, c.name]));
  const shown = moments.filter((m) => filter === 'all' || m.status === filter);
  const drafts = shown.filter((m) => m.status === 'draft');
  const approvedCount = moments.filter((m) => m.status === 'approved').length;

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900/60" data-testid="moments-panel">
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
          Moves <span className="text-neutral-600">{moments.length}</span>
        </h2>
        <span className="text-[11px] text-neutral-500 tabular-nums">
          {approvedCount}/{moments.length} approved
        </span>
      </header>

      <div className="flex gap-1 px-2 pt-2 text-xs">
        {(['all', 'draft', 'approved'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded px-2 py-0.5 capitalize ${filter === f ? 'bg-neutral-700 text-neutral-50' : 'text-neutral-400 hover:text-neutral-200'}`}
          >
            {f === 'all' ? 'All' : f === 'draft' ? 'Drafts' : 'Approved'}
          </button>
        ))}
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 && (
          <li className="px-1 py-6 text-center text-xs text-neutral-500">
            {moments.length === 0 ? 'No moves yet. Press M to add one at the playhead.' : 'Nothing here.'}
          </li>
        )}
        {shown.map((m) => {
          const style = theme.classifications[m.classification];
          const actor = m.actorId ? names.get(m.actorId) : undefined;
          return (
            <li key={m.id}>
              <button
                type="button"
                data-testid="moment-item"
                data-moment-id={m.id}
                onClick={() => {
                  store.getState().select(m.id);
                  goToMoment(m.id);
                }}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${
                  m.id === selectedId ? 'bg-neutral-800' : 'hover:bg-neutral-800/50'
                }`}
              >
                <span className="mt-0.5">
                  <Badge badge={style.badge} color={style.color} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-neutral-100">
                    {m.moveLabel || <span className="text-neutral-500 italic">Untitled move</span>}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500 tabular-nums">
                    {actor && `${actor} · `}
                    {formatTime(m.sourceTime)} · {m.holdSec.toFixed(1)} s
                  </span>
                </span>
                <span
                  title={m.status === 'approved' ? 'Approved' : 'Draft'}
                  className="mt-1.5 size-2.5 shrink-0 rounded-full"
                  style={
                    m.status === 'approved'
                      ? { background: style.color }
                      : { border: `1.5px solid ${style.color}`, background: `repeating-linear-gradient(135deg, ${style.color} 0 1.5px, transparent 1.5px 3px)` }
                  }
                />
              </button>
            </li>
          );
        })}
      </ol>

      {drafts.length > 0 && (
        <footer className="border-t border-neutral-800 p-2">
          <button
            type="button"
            onClick={() => store.getState().edit((d) => setStatus(d, drafts.map((m) => m.id), 'approved'))}
            className="w-full rounded-md border border-neutral-700 py-1.5 text-xs text-neutral-200 hover:border-neutral-500"
          >
            Approve {drafts.length} draft{drafts.length === 1 ? '' : 's'}
          </button>
        </footer>
      )}
    </section>
  );
}
