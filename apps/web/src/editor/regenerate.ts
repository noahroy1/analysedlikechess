import { NO_BEST_MOVE, type MoveDraft } from '@als/schema';
import { regenerateMoment } from '../lib/api.ts';
import { updateMoment } from './doc.ts';
import type { EditorStore } from './store.ts';

/** Asks the server for a new version of one moment's card. The result waits as a proposal. */
export async function requestRegeneration(store: EditorStore, momentId: string, instruction?: string): Promise<void> {
  const { doc, project } = store.getState();
  const moment = doc.moments.find((m) => m.id === momentId);
  if (!moment) return;
  store.getState().setProposal({ momentId, status: 'loading', ...(instruction ? { instruction } : {}) });
  try {
    const result = await regenerateMoment(project.id, moment, instruction);
    // A newer request (or a discard) wins over this one.
    if (store.getState().proposal?.momentId !== momentId) return;
    store.getState().setProposal({ momentId, status: 'ready', draft: result.draft, costUsd: result.costUsd, ...(instruction ? { instruction } : {}) });
  } catch (error) {
    if (store.getState().proposal?.momentId !== momentId) return;
    store.getState().setProposal({ momentId, status: 'error', error: error instanceof Error ? error.message : String(error) });
  }
}

/** Puts a drafted card on the moment as one undo step. Timing, placement and status stay. */
export function applyDraft(store: EditorStore, momentId: string, draft: MoveDraft) {
  store.getState().edit((d) =>
    updateMoment(d, momentId, {
      classification: draft.classification,
      moveLabel: draft.moveLabel,
      explanation: draft.explanation,
      bestMove: NO_BEST_MOVE.has(draft.classification) ? undefined : (draft.bestMove ?? undefined),
      motif: draft.motif?.trim() || undefined,
      confidence: Math.min(1, Math.max(0, draft.confidence)),
    }),
  );
}

export function acceptProposal(store: EditorStore) {
  const proposal = store.getState().proposal;
  if (proposal?.status !== 'ready' || !proposal.draft) return;
  applyDraft(store, proposal.momentId, proposal.draft);
  store.getState().setProposal(null);
}

/**
 * Drafts the text of a move just made from the transcript. Fills the card if it
 * is still blank; if the creator has started typing, the draft waits as a proposal.
 */
export async function draftNewMove(store: EditorStore, momentId: string): Promise<void> {
  await requestRegeneration(store, momentId);
  const { proposal, doc } = store.getState();
  const moment = doc.moments.find((m) => m.id === momentId);
  if (proposal?.momentId !== momentId || proposal.status !== 'ready' || !moment) return;
  if (!moment.moveLabel && !moment.explanation) acceptProposal(store);
}
