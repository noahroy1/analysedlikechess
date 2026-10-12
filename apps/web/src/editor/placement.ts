import { regionsFresh, type Moment } from '@als/schema';
import { useEffect, useRef } from 'react';
import { findRegions } from '../lib/api.ts';
import { formatUsd } from '../lib/format.ts';
import { useEditor, useEditorStore } from './context.tsx';
import { applyFoundRegions, placeCard } from './doc.ts';
import type { EditorStore } from './store.ts';

/** Quiet time after the last change before a moved frame is looked at, so a drag asks once. */
const SETTLE_MS = 600;
/** Retry interval while a drag is in progress. */
const RETRY_MS = 300;

const frameOf = (store: EditorStore) => {
  const { width, height } = store.getState().project.source;
  return { width, height };
};

/**
 * Keeps automatically placed cards clear of faces: when a move with an `auto`
 * card is retimed or added, its new frame is looked at and the card placed
 * again. The placement folds into the edit that caused it (one undo takes
 * back both). Cards set by hand are never touched.
 */
export function useAutoPlacement() {
  const store = useEditorStore();
  const moments = useEditor((s) => s.doc.moments);
  const asked = useRef(new Set<string>());

  useEffect(() => {
    const due = moments.filter((m) => m.card.placement === 'auto' && !regionsFresh(m));
    if (!due.length) return;
    const timer = setTimeout(() => {
      for (const moment of due) {
        const key = `${moment.id}@${moment.sourceTime}`;
        // Once per frame: a failure is not retried until the move moves again or Re-evaluate is pressed.
        if (asked.current.has(key)) continue;
        asked.current.add(key);
        void lookAndPlace(store, moment);
      }
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [moments, store]);
}

async function lookAndPlace(store: EditorStore, moment: Moment) {
  try {
    const { regions } = await findRegions(store.getState().project.id, moment);
    const apply = () => {
      const applied = store.getState().amend((d) => applyFoundRegions(d, moment.id, regions, store.getState().theme, frameOf(store)));
      if (!applied) setTimeout(apply, RETRY_MS);
    };
    apply();
  } catch (error) {
    store.getState().notify(`Could not place the card clear of faces: ${error instanceof Error ? error.message : String(error)}`, 'warn');
  }
}

/**
 * Re-evaluate: looks at the move's frame (free if it was already looked at)
 * and places its card clear of faces, replacing a position set by hand. One undo step.
 */
export async function reevaluatePlacement(store: EditorStore, momentId: string): Promise<void> {
  const moment = store.getState().doc.moments.find((m) => m.id === momentId);
  if (!moment) return;
  try {
    const result = await findRegions(store.getState().project.id, moment);
    const current = store.getState().doc.moments.find((m) => m.id === momentId);
    // The move was retimed meanwhile: the answer is for another frame.
    if (!current || Math.abs(current.sourceTime - result.regions.sourceTime) > 1e-4) return;
    store.getState().edit((d) => placeCard(d, momentId, result.regions, store.getState().theme, frameOf(store)));
    const faces = result.regions.faces.length;
    const cost = result.costUsd > 0 ? ` (${formatUsd(result.costUsd)})` : '';
    store.getState().notify(`Card placed clear of ${faces} face${faces === 1 ? '' : 's'}${cost}. Undo with ⌘Z / Ctrl+Z.`);
  } catch (error) {
    store.getState().notify(`Could not place the card: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}
