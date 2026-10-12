import { readFileSync } from 'node:fs';
import { ProjectSchema, placedByHand, type FrameRegions, type Project } from '@als/schema';
import { creatorTheme, defaultTheme } from '@als/theme';
import { describe, expect, it, vi } from 'vitest';
import * as ops from './doc.ts';
import { createEditorStore } from './store.ts';

const fixture = (): Project =>
  ProjectSchema.parse(JSON.parse(readFileSync(new URL('../../../../fixtures/sample/project.json', import.meta.url), 'utf8')));

const frame = { width: 1280, height: 720 };
/** One face top-right, its eyes and mouth in view. */
const regionsAt = (sourceTime: number): FrameRegions => ({
  sourceTime,
  faces: [{ head: { x: 0.6, y: 0.05, w: 0.3, h: 0.6 }, eyesMouth: { x: 0.65, y: 0.2, w: 0.2, h: 0.3 } }],
});

const docOf = (project: Project): ops.Doc => ({ moments: project.moments, characters: project.context.characters, themeId: project.themeId });
const m1 = (doc: ops.Doc) => doc.moments.find((m) => m.id === 'm1')!;

/** The sample with m1's card placed automatically on its frame. */
function placedDoc(): ops.Doc {
  const doc = docOf(fixture());
  return ops.placeCard(doc, 'm1', regionsAt(m1(doc).sourceTime), defaultTheme, frame);
}

describe('card placement in the document', () => {
  it('places a card clear of faces, from then on automatically', () => {
    const card = m1(placedDoc()).card;
    expect(card).toMatchObject({ anchor: 'custom', placement: 'auto' });
    expect(placedByHand(card)).toBe(false);
  });

  it('marks a card moved or resized by hand, and placement then leaves it alone', () => {
    const doc = ops.setCardByHand(placedDoc(), 'm1', { anchor: 'custom', x: 0.1, y: 0.1, scale: 1.2 });
    expect(m1(doc).card.placement).toBe('user');
    const after = ops.applyFoundRegions(doc, 'm1', regionsAt(m1(doc).sourceTime), defaultTheme, frame);
    expect(after).toBe(doc);
  });

  it('ignores regions for a frame the move has left', () => {
    const doc = ops.retime(placedDoc(), 'm1', 3, 10);
    expect(ops.applyFoundRegions(doc, 'm1', regionsAt(2), defaultTheme, frame)).toBe(doc);
    const placed = ops.applyFoundRegions(doc, 'm1', regionsAt(m1(doc).sourceTime), defaultTheme, frame);
    expect(m1(placed).regions?.sourceTime).toBe(m1(doc).sourceTime);
  });

  it('moves automatic cards to fit a new look, and only those', () => {
    let doc = placedDoc();
    doc = ops.setCardByHand(doc, 'm2', { anchor: 'top-left', scale: 1 });
    const next = ops.replaceAutoCards(ops.setTheme(doc, 'creator'), creatorTheme, frame);
    // The creator's badge sits beside the card, so the card moves to make room.
    expect(m1(next).card).not.toEqual(m1(doc).card);
    expect(next.moments.find((m) => m.id === 'm2')!.card).toEqual(doc.moments.find((m) => m.id === 'm2')!.card);
  });

  it('gives a new move a card that waits for its frame to be looked at', () => {
    const { doc, id } = ops.addMoment(docOf(fixture()), { sourceTime: 0.5 }, defaultTheme, 10);
    expect(doc.moments.find((m) => m.id === id)!.card.placement).toBe('auto');
  });
});

describe('amend', () => {
  it('folds a placement into the retime that caused it: one undo takes back both', () => {
    const project = { ...fixture(), moments: placedDoc().moments };
    const store = createEditorStore(project, { save: vi.fn(async () => ({ kind: 'saved' as const, version: 2 })), reload: vi.fn() });
    const before = m1(store.getState().doc);
    store.getState().edit((d) => ops.retime(d, 'm1', 2.6, 10));
    const at = m1(store.getState().doc).sourceTime;
    expect(store.getState().amend((d) => ops.applyFoundRegions(d, 'm1', regionsAt(at), store.getState().theme, frame))).toBe(true);
    expect(m1(store.getState().doc).regions?.sourceTime).toBe(at);
    store.getState().undo();
    expect(m1(store.getState().doc)).toEqual(before);
  });

  it('waits while a drag is in progress', () => {
    const store = createEditorStore(fixture(), { save: vi.fn(), reload: vi.fn() });
    store.getState().beginGesture();
    expect(store.getState().amend((d) => ops.updateMoment(d, 'm1', { moveLabel: 'x' }))).toBe(false);
    store.getState().endGesture();
  });
});
