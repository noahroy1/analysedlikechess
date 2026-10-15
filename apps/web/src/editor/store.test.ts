import { readFileSync } from 'node:fs';
import { ProjectSchema, type Project } from '@als/schema';
import { defaultTheme } from '@als/theme';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ops from './doc.ts';
import { AUTOSAVE_DELAY_MS, COALESCE_MS, createEditorStore, type EditorDeps } from './store.ts';

const fixture = (): Project =>
  ProjectSchema.parse(
    JSON.parse(readFileSync(new URL('../../../../fixtures/sample/project.json', import.meta.url), 'utf8')),
  );

function setup(overrides: Partial<EditorDeps> = {}) {
  const project = fixture();
  let serverVersion = project.version;
  const saves: { version: number; label: string }[] = [];
  const deps: EditorDeps = {
    save: vi.fn(async (edit) => {
      if (edit.version !== serverVersion) return { kind: 'conflict' as const };
      saves.push({ version: edit.version, label: edit.moments[0]!.moveLabel });
      serverVersion += 1;
      return { kind: 'saved' as const, version: serverVersion };
    }),
    reload: vi.fn(async () => ({ ...fixture(), version: serverVersion })),
    ...overrides,
  };
  const store = createEditorStore(project, deps);
  const label = () => store.getState().doc.moments[0]!.moveLabel;
  const setLabel = (text: string, coalesce?: string) =>
    store.getState().edit((d) => ops.updateMoment(d, 'm1', { moveLabel: text }), coalesce ? { coalesce } : undefined);
  return {
    store,
    deps,
    saves,
    label,
    setLabel,
    bumpServer: () => (serverVersion += 1),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('undo and redo', () => {
  it('undoes and redoes edits in order', () => {
    const { store, label, setLabel } = setup();
    const original = label();
    setLabel('One');
    setLabel('Two');
    store.getState().undo();
    expect(label()).toBe('One');
    store.getState().undo();
    expect(label()).toBe(original);
    store.getState().redo();
    expect(label()).toBe('One');
  });

  it('merges typing in one field into a single step', () => {
    const { store, label, setLabel } = setup();
    const original = label();
    for (const text of ['S', 'Sp', 'Spl', 'Spli', 'Split']) {
      setLabel(text, 'm1.moveLabel');
      vi.advanceTimersByTime(100);
    }
    store.getState().undo();
    expect(label()).toBe(original);
  });

  it('starts a new step after a pause in typing', () => {
    const { store, label, setLabel } = setup();
    setLabel('Split', 'm1.moveLabel');
    vi.advanceTimersByTime(COALESCE_MS + 100);
    setLabel('Split up', 'm1.moveLabel');
    store.getState().undo();
    expect(label()).toBe('Split');
  });

  it('undoes a whole drag as one step', () => {
    const { store } = setup();
    const t0 = store.getState().doc.moments[1]!.sourceTime;
    store.getState().beginGesture();
    for (const t of [3, 3.2, 3.4]) store.getState().gesture((d) => ops.retime(d, 'm2', t, 10));
    store.getState().endGesture();
    expect(store.getState().doc.moments[1]!.sourceTime).toBe(3.4);
    store.getState().undo();
    expect(store.getState().doc.moments[1]!.sourceTime).toBe(t0);
  });

  it('a new edit clears the redo stack', () => {
    const { store, setLabel } = setup();
    setLabel('One');
    store.getState().undo();
    setLabel('Other');
    expect(store.getState().future).toEqual([]);
  });
});

describe('holds follow the text', () => {
  it('recomputes an unlocked hold as the explanation changes', () => {
    const { store } = setup();
    const before = store.getState().doc.moments[0]!.holdSec;
    store.getState().edit((d) => ops.updateMoment(d, 'm1', { explanation: `${d.moments[0]!.explanation} Ten more words to type out before the card can leave.` }));
    expect(store.getState().doc.moments[0]!.holdSec).toBeGreaterThan(before);
  });

  it('drops the best move when the rating changes to one that never has it', () => {
    const { store } = setup();
    expect(store.getState().doc.moments[0]!.bestMove).toBeDefined();
    for (const classification of ['great', 'book', 'brilliant', 'best'] as const) {
      store.getState().edit((d) => ops.setClassification(d, 'm1', classification));
      expect(store.getState().doc.moments[0]!.bestMove).toBeUndefined();
      store.getState().undo();
      expect(store.getState().doc.moments[0]!.bestMove).toBeDefined();
    }
  });

  it('leaves a hold set by hand alone', () => {
    const { store, setLabel } = setup();
    store.getState().edit((d) => ops.updateMoment(d, 'm1', { holdSec: 5, holdLocked: true }));
    setLabel('x'.repeat(40));
    expect(store.getState().doc.moments[0]!.holdSec).toBe(5);
  });
});

describe('autosave', () => {
  it(`saves ${AUTOSAVE_DELAY_MS} ms after the last edit, with the base version`, async () => {
    const { store, deps, setLabel } = setup();
    setLabel('A');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100);
    setLabel('AB');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100);
    expect(deps.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ saveStatus: 'saved', baseVersion: 2 });
  });

  it('saves edits made during a save right after it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { store, saves, deps } = setup();
    const save = deps.save;
    deps.save = vi.fn(async (edit) => {
      await gate;
      return save(edit);
    });
    const s = createEditorStore(store.getState().project, deps);
    s.getState().edit((d) => ops.updateMoment(d, 'm1', { moveLabel: 'First' }));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    s.getState().edit((d) => ops.updateMoment(d, 'm1', { moveLabel: 'Second' }));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    release();
    await s.getState().flush();
    expect(saves.map((x) => x.label)).toEqual(['First', 'Second']);
    expect(s.getState()).toMatchObject({ saveStatus: 'saved', baseVersion: 3 });
  });

  it('does not send a doc that breaks the track rules', async () => {
    const { store, deps } = setup();
    store.getState().edit((d) => ({ ...d, moments: d.moments.map((m) => ({ ...m, sourceTime: 2 })) }));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(deps.save).not.toHaveBeenCalled();
    expect(store.getState().saveStatus).toBe('invalid');
  });

  it('reloads instead of overwriting when the save is stale', async () => {
    const { store, deps, setLabel, bumpServer } = setup();
    bumpServer();
    setLabel('Local edit');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    await store.getState().flush();
    expect(deps.reload).toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ baseVersion: 2, saveStatus: 'saved', past: [] });
    expect(store.getState().doc.moments[0]!.moveLabel).toBe('Splits Up');
    expect(store.getState().toast?.tone).toBe('warn');
  });

  it('a reload does not trigger a save of its own', async () => {
    const { store, deps } = setup();
    await store.getState().reload();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe('doc operations', () => {
  const doc = (): ops.Doc => {
    const p = fixture();
    return { moments: p.moments, characters: p.context.characters, themeId: p.themeId, format: 'long' };
  };

  it('retiming never crosses a neighbour or the minimum gap', () => {
    expect(ops.retime(doc(), 'm2', 0, 10).moments[1]!.sourceTime).toBe(2.5);
    expect(ops.retime(doc(), 'm2', 9, 10).moments[1]!.sourceTime).toBe(7.9);
    expect(ops.retime(doc(), 'm3', 99, 10).moments[2]!.sourceTime).toBe(10);
  });

  it('refuses to add a moment too close to another', () => {
    expect(() => ops.addMoment(doc(), { sourceTime: 2.2 }, defaultTheme, 10)).toThrow(ops.EditError);
    const { doc: next, id } = ops.addMoment(doc(), { sourceTime: 3.5 }, defaultTheme, 10);
    expect(next.moments.find((m) => m.id === id)).toMatchObject({ origin: 'user', status: 'draft', classification: 'good' });
  });

  it('merging characters moves labels and moves', () => {
    const merged = ops.mergeCharacters(doc(), 'c-blue', 'c-red');
    expect(merged.characters).toEqual([{ id: 'c-red', name: 'Red', speakerLabels: ['A', 'B'], side: 'white' }]);
    expect(merged.moments.every((m) => m.actorId === 'c-red')).toBe(true);
  });

  it('sets and clears the side a character plays', () => {
    const black = ops.setSide(doc(), 'c-red', 'black');
    expect(black.characters.find((c) => c.id === 'c-red')?.side).toBe('black');
    expect('side' in ops.setSide(black, 'c-red', undefined).characters.find((c) => c.id === 'c-red')!).toBe(false);
  });

  it('switching theme recomputes unlocked holds from the new timing', () => {
    const { store } = setup();
    const before = store.getState().doc.moments[0]!.holdSec;
    store.getState().edit((d) => ops.setTheme(d, 'creator'));
    expect(store.getState().theme.id).toBe('creator');
    // The creator's badge pops before the card, so the hold is longer.
    expect(store.getState().doc.moments[0]!.holdSec).toBeGreaterThan(before);
    store.getState().undo();
    expect(store.getState()).toMatchObject({ theme: { id: 'default' } });
    expect(store.getState().doc.moments[0]!.holdSec).toBe(before);
  });

  it('switching to short-form shortens unlocked holds, saves the format and undoes', async () => {
    const { store, deps } = setup();
    expect(store.getState().doc.format).toBe('long');
    const before = store.getState().doc.moments[0]!.holdSec;
    store.getState().edit((d) => ops.setFormat(d, 'short'));
    expect(store.getState().doc.moments[0]!.holdSec).toBeCloseTo(before - 2.6, 5);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ format: 'short' }));
    store.getState().undo();
    expect(store.getState().doc.moments[0]!.holdSec).toBe(before);
  });

  it('renames the project and sizes the bar as saved, undoable edits', async () => {
    const { store, deps } = setup();
    store.getState().edit((d) => ops.setTitle(d, '  Grandpa’s pond  '));
    store.getState().edit((d) => ops.setEvalBarScale(d, 0.8));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Grandpa’s pond', evalBarScale: 0.8 }));
    expect(store.getState().project).toMatchObject({ title: 'Grandpa’s pond', evalBarScale: 0.8 });
    // Back to full size and a blank name: both are stored as absent.
    expect('evalBarScale' in ops.setEvalBarScale(store.getState().doc, 1)).toBe(false);
    expect('title' in ops.setTitle(store.getState().doc, ' ')).toBe(false);
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().doc.title).toBeUndefined();
  });

  it('edits the game review’s accuracy and summary as saved, undoable edits', async () => {
    const { store, deps } = setup();
    store.getState().edit((d) => ops.setReviewAccuracy(d, 'white', 71.64));
    store.getState().edit((d) => ops.setReviewSummary(d, 'Red won '));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ gameReview: { accuracy: { white: 71.6 }, summary: 'Red won ' } }));
    expect(store.getState().project.gameReview).toEqual({ accuracy: { white: 71.6 }, summary: 'Red won ' });
    // Clearing both goes back to the defaults, stored as absent.
    const cleared = ops.setReviewSummary(ops.setReviewAccuracy(store.getState().doc, 'white', undefined), '  ');
    expect('gameReview' in cleared).toBe(false);
    expect(ops.setReviewAccuracy(store.getState().doc, 'black', 140).gameReview?.accuracy).toEqual({ white: 71.6, black: 100 });
    store.getState().undo();
    expect(store.getState().doc.gameReview).toEqual({ accuracy: { white: 71.6 } });
  });

  it('assigning a speaker label takes it off everyone else', () => {
    const next = ops.assignSpeaker(doc(), 'A', 'c-blue');
    expect(next.characters.map((c) => c.speakerLabels)).toEqual([[], ['B', 'A']]);
  });

  it('deleting a character clears the moves it made', () => {
    const next = ops.deleteCharacter(doc(), 'c-blue');
    expect(next.moments[1]!.actorId).toBeUndefined();
    expect(next.characters).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('autosave survives a dispose and activate (React remounting the editor)', async () => {
    const { store, deps, setLabel } = setup();
    store.getState().dispose();
    store.getState().activate();
    setLabel('After remount');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(deps.save).toHaveBeenCalledTimes(1);
  });
});
