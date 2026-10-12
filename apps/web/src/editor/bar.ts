import { evaluateTrack } from '../lib/api.ts';
import { addBeat, applyEvaluation } from './doc.ts';
import type { EditorStore } from './store.ts';

/** Adds a beat at a source time, holding the bar's current value, and selects it. */
export function addBeatAt(store: EditorStore, sourceSec: number) {
  const { doc, project } = store.getState();
  let id = '';
  store.getState().edit((d) => {
    const added = addBeat(d, { sourceTime: sourceSec }, project.source.durationSec);
    id = added.id;
    return added.doc;
  });
  if (id) store.getState().select(id);
  if (!doc.evalBar) store.getState().notify('Beat added. The bar starts level; set its start with nothing selected.');
}

/**
 * Pass C for the track as it stands. The result goes straight onto the track
 * as one undo step: the creator asked for it, and ⌘Z brings back what was there.
 */
export async function reevaluateBar(store: EditorStore): Promise<void> {
  const { doc, project } = store.getState();
  const result = await evaluateTrack(project.id, {
    moments: doc.moments,
    characters: doc.characters,
    ...(doc.evalBar ? { evalBar: doc.evalBar } : {}),
  });
  store.getState().edit((d) => applyEvaluation(d, result));
  const values = Object.keys(result.evals).length + result.evalBar.beats.length;
  const adjusted = result.adjusted.length ? `; ${result.adjusted.length} held to the rules` : '';
  store.getState().notify(`Bar re-evaluated: ${values} values${adjusted} ($${result.costUsd.toFixed(3)}). Undo with ⌘Z / Ctrl+Z.`);
}
