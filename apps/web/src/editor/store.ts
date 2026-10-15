import { ProjectSchema, projectFormat, type MoveDraft, type Project, type ProjectEdit, type Theme } from '@als/schema';
import { getTheme } from '@als/theme';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { hasItem, normalize, type Doc } from './doc.ts';

export const AUTOSAVE_DELAY_MS = 500;
/** Edits with the same coalesce key this close together undo as one step (typing). */
export const COALESCE_MS = 1200;
const HISTORY_DEPTH = 200;

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'invalid' | 'error';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'warn' | 'error';
}

export interface EditorState {
  /** The project as last loaded or saved, for everything the editor doesn't change. */
  project: Project;
  doc: Doc;
  theme: Theme;
  /** Server version `doc` is based on; sent with every save. */
  baseVersion: number;
  past: Doc[];
  future: Doc[];
  selectedId: string | null;
  saveStatus: SaveStatus;
  saveError: string | null;
  toast: Toast | null;
  /** A Regenerate result waiting for the creator to accept or discard. */
  proposal: Proposal | null;
  /** The character whose portrait is being cropped on the stage, if any. */
  portraitCrop: string | null;
  /** Asks the edit layer to put the cursor in a card field (e.g. after adding a move). */
  focusRequest: { id: string; field: 'moveLabel' | 'explanation' | 'bestMove'; n: number } | null;
}

export interface Proposal {
  momentId: string;
  status: 'loading' | 'ready' | 'error';
  instruction?: string;
  draft?: MoveDraft;
  costUsd?: number;
  error?: string;
}

export interface EditOptions {
  /** Merge with the previous edit of the same key into one undo step. */
  coalesce?: string;
}

export interface SaveOutcome {
  kind: 'saved' | 'conflict';
  version?: number;
}

export interface EditorDeps {
  save: (edit: ProjectEdit) => Promise<SaveOutcome>;
  reload: () => Promise<Project>;
}

export interface EditorActions {
  /** Applies a change to the doc as one undo step (or merged, see EditOptions). */
  edit: (recipe: (doc: Doc) => Doc, options?: EditOptions) => void;
  /**
   * Folds a follow-up into the last undo step, e.g. a card placed once a
   * retimed frame has been looked at: one undo takes back both. Waits (returns
   * false) while a drag is in progress.
   */
  amend: (recipe: (doc: Doc) => Doc) => boolean;
  /** Starts a drag: edits until `endGesture` apply live but undo as one step. */
  beginGesture: () => void;
  gesture: (recipe: (doc: Doc) => Doc) => void;
  endGesture: (commit?: boolean) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  notify: (text: string, tone?: Toast['tone']) => void;
  requestFocus: (id: string, field: 'moveLabel' | 'explanation' | 'bestMove') => void;
  setProposal: (proposal: Proposal | null) => void;
  setPortraitCrop: (characterId: string | null) => void;
  dismissToast: () => void;
  /** Saves now if anything is pending. */
  flush: () => Promise<void>;
  /** Resumes autosave after `dispose` (React may unmount and remount the same editor). */
  activate: () => void;
  /** Replaces the editor's state with the server's latest, e.g. after a history restore. */
  reload: () => Promise<void>;
  dispose: () => void;
}

export type EditorStore = StoreApi<EditorState & EditorActions>;

const docOf = (project: Project): Doc => ({
  ...(project.title ? { title: project.title } : {}),
  moments: project.moments,
  characters: project.context.characters,
  themeId: project.themeId,
  format: projectFormat(project),
  ...(project.evalBar ? { evalBar: project.evalBar } : {}),
  ...(project.evalBarScale ? { evalBarScale: project.evalBarScale } : {}),
  ...(project.subtitles ? { subtitles: project.subtitles } : {}),
  ...(project.gameReview ? { gameReview: project.gameReview } : {}),
});

/** The project with the doc's changes applied. */
const applyDoc = (project: Project, doc: Doc): Project => {
  const { evalBar: _, subtitles: __, title: ___, evalBarScale: ____, gameReview: _____, ...rest } = project;
  return {
    ...rest,
    ...(doc.title ? { title: doc.title } : {}),
    moments: doc.moments,
    context: { ...project.context, characters: doc.characters },
    themeId: doc.themeId,
    format: doc.format,
    ...(doc.evalBar ? { evalBar: doc.evalBar } : {}),
    ...(doc.evalBarScale ? { evalBarScale: doc.evalBarScale } : {}),
    ...(doc.subtitles ? { subtitles: doc.subtitles } : {}),
    ...(doc.gameReview ? { gameReview: doc.gameReview } : {}),
  };
};

/** The theme follows the document, so switching it undoes like any other edit. */
const withTheme = (doc: Doc) => ({ doc, theme: getTheme(doc.themeId) });
const normalized = (doc: Doc) => normalize(doc, getTheme(doc.themeId));

/** The editor's state for one project, with undo/redo and versioned autosave. */
export function createEditorStore(initial: Project, deps: EditorDeps): EditorStore {
  let lastCoalesce: { key: string; at: number } | null = null;
  let gestureBase: Doc | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let saveAgain = false;
  // Compared by reference: the doc last saved (or loaded) needs no save.
  let savedDoc: Doc = normalized(docOf(initial));
  let toastId = 0;

  const store = createStore<EditorState & EditorActions>()((set, get) => {
    const theme = getTheme(initial.themeId);

    const commit = (next: Doc, coalesce?: string) => {
      const { doc, past } = get();
      if (next === doc) return;
      const now = performance.now();
      const merge = coalesce !== undefined && lastCoalesce?.key === coalesce && now - lastCoalesce.at < COALESCE_MS;
      lastCoalesce = coalesce !== undefined ? { key: coalesce, at: now } : null;
      set({
        ...withTheme(next),
        past: merge ? past : [...past, doc].slice(-HISTORY_DEPTH),
        future: [],
      });
    };

    return {
      project: initial,
      doc: savedDoc,
      theme,
      baseVersion: initial.version,
      past: [],
      future: [],
      selectedId: null,
      saveStatus: 'saved',
      saveError: null,
      toast: null,
      focusRequest: null,
      proposal: null,
      portraitCrop: null,

      edit: (recipe, options) => commit(normalized(recipe(get().doc)), options?.coalesce),
      amend: (recipe) => {
        if (gestureBase) return false;
        const next = normalized(recipe(get().doc));
        if (next !== get().doc) set(withTheme(next));
        return true;
      },

      beginGesture: () => {
        gestureBase = get().doc;
        lastCoalesce = null;
      },
      gesture: (recipe) => set(withTheme(normalized(recipe(get().doc)))),
      endGesture: (keep = true) => {
        const base = gestureBase;
        gestureBase = null;
        if (!base) return;
        const { doc, past } = get();
        if (!keep) set(withTheme(base));
        else if (doc !== base) set({ past: [...past, base].slice(-HISTORY_DEPTH), future: [] });
        scheduleSave();
      },

      undo: () => {
        const { past, future, doc, selectedId } = get();
        const previous = past.at(-1);
        if (!previous) return;
        lastCoalesce = null;
        set({
          ...withTheme(previous),
          past: past.slice(0, -1),
          future: [doc, ...future],
          selectedId: hasItem(previous, selectedId) ? selectedId : null,
        });
      },
      redo: () => {
        const { past, future, doc, selectedId } = get();
        const next = future[0];
        if (!next) return;
        lastCoalesce = null;
        set({
          ...withTheme(next),
          past: [...past, doc],
          future: future.slice(1),
          selectedId: hasItem(next, selectedId) ? selectedId : null,
        });
      },

      select: (id) => set({ selectedId: id }),
      notify: (text, tone = 'info') => set({ toast: { id: ++toastId, text, tone } }),
      dismissToast: () => set({ toast: null }),
      setProposal: (proposal) => set({ proposal }),
      setPortraitCrop: (portraitCrop) => set({ portraitCrop }),
      requestFocus: (id, field) => set((s) => ({ focusRequest: { id, field, n: (s.focusRequest?.n ?? 0) + 1 } })),

      flush: async () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          await save();
        }
        while (inFlight) await inFlight;
      },
      reload: async () => load(await deps.reload()),
      activate: () => {
        unsubscribe ??= store.subscribe(onChange);
      },
      dispose: () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  });

  function scheduleSave() {
    if (gestureBase) return;
    if (saveTimer) clearTimeout(saveTimer);
    store.setState({ saveStatus: 'pending' });
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void save();
    }, AUTOSAVE_DELAY_MS);
  }

  /** One save at a time; anything edited meanwhile goes out right after. */
  function save(): Promise<void> {
    if (inFlight) {
      saveAgain = true;
      return inFlight;
    }
    inFlight = sendSave().finally(() => {
      inFlight = null;
      if (saveAgain) {
        saveAgain = false;
        void save();
      }
    });
    return inFlight;
  }

  async function sendSave() {
    const { doc, project, baseVersion } = store.getState();
    if (doc === savedDoc) {
      store.setState({ saveStatus: 'saved' });
      return;
    }
    const check = ProjectSchema.safeParse(applyDoc(project, doc));
    if (!check.success) {
      store.setState({ saveStatus: 'invalid', saveError: check.error.issues[0]?.message ?? 'invalid project' });
      return;
    }
    store.setState({ saveStatus: 'saving', saveError: null });
    try {
      const outcome = await deps.save({
        version: baseVersion,
        moments: doc.moments,
        characters: doc.characters,
        themeId: doc.themeId,
        format: doc.format,
        ...(doc.evalBar ? { evalBar: doc.evalBar } : {}),
        ...(doc.subtitles ? { subtitles: doc.subtitles } : {}),
        ...(doc.title ? { title: doc.title } : {}),
        ...(doc.evalBarScale ? { evalBarScale: doc.evalBarScale } : {}),
        ...(doc.gameReview ? { gameReview: doc.gameReview } : {}),
      });
      if (outcome.kind === 'conflict') {
        saveAgain = false;
        await reloadAfterConflict();
        return;
      }
      savedDoc = doc;
      store.setState((s) => ({
        baseVersion: outcome.version!,
        project: { ...applyDoc(s.project, doc), version: outcome.version! },
        saveStatus: s.doc === doc ? 'saved' : 'pending',
      }));
    } catch (error) {
      store.setState({ saveStatus: 'error', saveError: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The plan's rule: never overwrite a newer version; load it instead. */
  async function reloadAfterConflict() {
    load(await deps.reload());
    store.getState().notify('This project changed somewhere else, so the latest version was loaded.', 'warn');
  }

  function load(project: Project) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    lastCoalesce = null;
    const theme = getTheme(project.themeId);
    const doc = normalize(docOf(project), theme);
    savedDoc = doc;
    store.setState((s) => ({
      project,
      theme,
      doc,
      baseVersion: project.version,
      past: [],
      future: [],
      selectedId: hasItem(doc, s.selectedId) ? s.selectedId : null,
      saveStatus: 'saved',
      saveError: null,
    }));
  }

  function onChange(state: EditorState, prev: EditorState) {
    if (state.doc !== prev.doc && state.doc !== savedDoc) scheduleSave();
  }
  let unsubscribe: (() => void) | null = store.subscribe(onChange);

  return store;
}
