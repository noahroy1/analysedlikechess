import { Badge } from '@als/theme';
import { useState } from 'react';
import { useEditor, useEditorStore } from '../../editor/context.tsx';
import { acceptProposal, requestRegeneration } from '../../editor/regenerate.ts';
import { formatUsd } from '../../lib/format.ts';

const SUGGESTIONS = ['funnier', 'shorter', 'rate it a blunder instead'];

/**
 * Regenerate one move's card with an optional instruction. The result sits next
 * to the current text; nothing is overwritten until the creator accepts it.
 */
export function RegeneratePanel({ momentId }: { momentId: string }) {
  const store = useEditorStore();
  const theme = useEditor((s) => s.theme);
  const proposal = useEditor((s) => (s.proposal?.momentId === momentId ? s.proposal : null));
  const [instruction, setInstruction] = useState('');
  const loading = proposal?.status === 'loading';
  const draft = proposal?.status === 'ready' ? proposal.draft : undefined;
  const style = draft ? theme.classifications[draft.classification] : undefined;

  const regenerate = (text = instruction) => void requestRegeneration(store, momentId, text.trim() || undefined);

  return (
    <section className="rounded-md border border-neutral-800 p-2.5" data-testid="regenerate">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          regenerate();
        }}
      >
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Optional: funnier, shorter, rate it a blunder…"
          aria-label="Regenerate instruction"
          className="input flex-1 py-1 text-xs"
        />
        <button
          type="submit"
          disabled={loading}
          className="shrink-0 rounded-md border border-neutral-700 px-2 text-xs text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
        >
          {loading ? 'Writing…' : 'Regenerate'}
        </button>
      </form>
      {!proposal && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setInstruction(s);
                regenerate(s);
              }}
              className="rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {proposal?.status === 'error' && <p className="mt-2 text-xs text-red-300">{proposal.error}</p>}

      {draft && style && (
        <div className="mt-2.5 rounded-md border border-sky-900/70 bg-sky-950/20 p-2 text-xs" data-testid="proposal">
          <div className="flex items-center gap-1.5">
            <Badge badge={style.badge} color={style.color} size={16} />
            <span className="font-semibold" style={{ color: style.color }}>
              {style.label}
            </span>
            <span className="ml-auto text-[10px] text-neutral-500 tabular-nums">{proposal?.costUsd !== undefined && formatUsd(proposal.costUsd)}</span>
          </div>
          <p className="mt-1 font-medium text-neutral-100">{draft.moveLabel}</p>
          <p className="mt-0.5 text-neutral-300">{draft.explanation}</p>
          {draft.bestMove && (
            <p className="mt-1 text-neutral-400">
              <span className="font-semibold text-neutral-300">Best move:</span> {draft.bestMove}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => acceptProposal(store)} className="rounded bg-sky-500 px-2.5 py-1 font-medium text-neutral-950 hover:bg-sky-400">
              Use this
            </button>
            <button type="button" onClick={() => store.getState().setProposal(null)} className="rounded border border-neutral-700 px-2.5 py-1 text-neutral-300 hover:border-neutral-500">
              Discard
            </button>
            <button type="button" onClick={() => regenerate()} className="ml-auto text-neutral-400 hover:text-neutral-200">
              Try again
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
