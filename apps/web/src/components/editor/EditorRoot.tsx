import type { Analysis, HistoryEntry, Ingest, Project } from '@als/schema';
import { useEffect, useRef, useState } from 'react';
import { THEMES } from '@als/theme';
import { EditorProvider, useEditor, useEditorStore } from '../../editor/context.tsx';
import { setTheme } from '../../editor/doc.ts';
import { createEditorStore, type EditorStore, type SaveStatus } from '../../editor/store.ts';
import { getProject, listHistory, restoreVersion, saveProject } from '../../lib/api.ts';
import { formatFps, formatTime } from '../../lib/format.ts';
import { projectsHref } from '../../lib/router.ts';
import { StageList, StatusBadge } from '../StageList.tsx';
import { AnalysisPanel } from './AnalysisPanel.tsx';
import { CharactersPanel } from './CharactersPanel.tsx';
import { SubtitlesPanel } from './SubtitlesPanel.tsx';
import { Inspector } from './Inspector.tsx';
import { HeaderButton } from './HeaderButton.tsx';
import { MomentsPanel } from './MomentsPanel.tsx';
import { RenderMenu } from './RenderMenu.tsx';
import { Workspace } from './Workspace.tsx';

export interface EditorRootProps {
  project: Project;
  /** Live ingest state, which may be newer than the project's. */
  ingest: Ingest;
  /** Live analysis state. */
  analysis: Analysis;
  onAnalysisChange: (analysis: Analysis) => void;
  onRerunIngest: () => void;
  onDelete: () => void;
}

/** The editor for one project: owns the store for as long as the page is open. */
export function EditorRoot({ project, ingest, analysis, onAnalysisChange, onRerunIngest, onDelete }: EditorRootProps) {
  const [store] = useState<EditorStore>(() =>
    createEditorStore(project, {
      save: (edit) => saveProject(project.id, edit),
      reload: () => getProject(project.id),
    }),
  );

  // Save anything pending when leaving; warn if the tab closes mid-save.
  useEffect(() => {
    store.getState().activate();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const status = store.getState().saveStatus;
      if (status === 'pending' || status === 'saving') {
        void store.getState().flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Start the final save, then detach now: StrictMode remounts right away and re-activates.
      void store.getState().flush();
      store.getState().dispose();
    };
  }, [store]);

  // A finished re-ingest changed the project on the server (new version, maybe new shots).
  const lastIngest = useRef(ingest.status);
  useEffect(() => {
    if (lastIngest.current !== ingest.status && ingest.status === 'done') {
      void store.getState().flush().then(() => store.getState().reload());
    }
    lastIngest.current = ingest.status;
  }, [ingest.status, store]);

  // Finished analysis wrote drafts into the project: save anything pending, then load them.
  const lastAnalysis = useRef(analysis.status);
  useEffect(() => {
    const was = lastAnalysis.current;
    lastAnalysis.current = analysis.status;
    if ((was === 'running' || was === 'pending') && (analysis.status === 'done' || analysis.status === 'error')) {
      void store
        .getState()
        .flush()
        .then(() => store.getState().reload())
        .then(() => {
          if (analysis.status === 'done') {
            const count = store.getState().doc.moments.filter((m) => m.origin === 'ai' && m.status === 'draft').length;
            store.getState().notify(`Drafts ready: ${count} move${count === 1 ? '' : 's'} to review.`);
          }
        });
    }
  }, [analysis.status, store]);

  return (
    <EditorProvider store={store}>
      <div className="px-4 py-4 sm:px-6">
        <Header ingest={ingest} analysis={analysis} onRerunIngest={onRerunIngest} onDelete={onDelete} />
        {(analysis.status === 'pending' || analysis.status === 'running') && (
          <p className="mt-3 rounded-md border border-sky-900/60 bg-sky-950/30 px-3 py-1.5 text-xs text-sky-200" data-testid="analysis-banner">
            Drafting moves… The drafts load here when they are ready. Edits you make meanwhile may be replaced, except approved moves and moves you add.
          </p>
        )}
        <div className="mt-4">
          <Workspace
            left={<MomentsPanel />}
            right={<RightPanel ingest={ingest} analysis={analysis} onAnalysisChange={onAnalysisChange} />}
          />
        </div>
        <ToastView />
      </div>
    </EditorProvider>
  );
}

function Header({ ingest, analysis, onRerunIngest, onDelete }: Omit<EditorRootProps, 'project' | 'onAnalysisChange'>) {
  const store = useEditorStore();
  const project = useEditor((s) => s.project);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const { source } = project;
  const working = ingest.status === 'pending' || ingest.status === 'running';

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <a href={projectsHref} className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Projects
      </a>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {project.context.movieTitle || source.originalName || project.id}
          </h1>
          <StatusBadge ingest={ingest} analysis={analysis} />
        </div>
        <p className="text-xs text-neutral-500 tabular-nums">
          {project.context.sceneNote && <span className="text-neutral-400">{project.context.sceneNote} · </span>}
          {formatTime(source.durationSec)} · {source.width}×{source.height} · {formatFps(source.fps)} fps
          {project.shots && ` · ${project.shots.length} shots`}
        </p>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <SaveIndicator />
        <div className="flex">
          <HeaderButton onClick={() => store.getState().undo()} disabled={!canUndo} title="Undo (⌘Z / Ctrl+Z)" first>
            Undo
          </HeaderButton>
          <HeaderButton onClick={() => store.getState().redo()} disabled={!canRedo} title="Redo (⇧⌘Z / Ctrl+Shift+Z)" last>
            Redo
          </HeaderButton>
        </div>
        <ThemePicker />
        <HistoryMenu />
        <RenderMenu />
        <HeaderButton onClick={onRerunIngest} disabled={working} title="Re-run ingest (unchanged steps are skipped)">
          Re-run ingest
        </HeaderButton>
        <HeaderButton onClick={onDelete} disabled={working} title="Delete this project and its files" danger>
          Delete
        </HeaderButton>
      </div>
    </header>
  );
}

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: 'Saved',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  invalid: 'Not saved',
  error: 'Save failed',
};

function SaveIndicator() {
  const status = useEditor((s) => s.saveStatus);
  const error = useEditor((s) => s.saveError);
  const bad = status === 'invalid' || status === 'error';
  return (
    <span
      className={`text-xs tabular-nums ${bad ? 'text-red-400' : status === 'saved' ? 'text-neutral-500' : 'text-neutral-300'}`}
      title={error ?? undefined}
      data-testid="save-status"
      data-status={status}
    >
      {status === 'saved' ? '✓ ' : ''}
      {SAVE_TEXT[status]}
      {bad && error ? `: ${error}` : ''}
    </span>
  );
}

/** The last 20 saved versions; restoring one saves it as the newest. */
/** The project's look: cards, badges, timing and holds all follow it. Undoable like any edit. */
function ThemePicker() {
  const store = useEditorStore();
  const themeId = useEditor((s) => s.doc.themeId);
  return (
    <label className="flex items-center gap-1.5 text-xs text-neutral-400" title="Card look (holds follow its timing)">
      Look
      <select
        value={themeId}
        data-testid="theme-picker"
        onChange={(e) => store.getState().edit((d) => setTheme(d, e.target.value))}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function HistoryMenu() {
  const store = useEditorStore();
  const projectId = useEditor((s) => s.project.id);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void store
      .getState()
      .flush()
      .then(() => listHistory(projectId))
      .then((list) => !cancelled && setEntries(list));
    return () => {
      cancelled = true;
    };
  }, [open, projectId, store]);

  const restore = async (version: number) => {
    const s = store.getState();
    await s.flush();
    try {
      await restoreVersion(projectId, version, store.getState().baseVersion);
      await store.getState().reload();
      store.getState().notify(`Restored the moves from version ${version}.`);
    } catch (error) {
      store.getState().notify((error as Error).message, 'error');
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <HeaderButton onClick={() => setOpen((o) => !o)} title="Earlier saved versions">
        History
      </HeaderButton>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 rounded-md border border-neutral-700 bg-neutral-950 p-1 shadow-xl" data-testid="history-menu">
          {entries === null && <p className="p-2 text-xs text-neutral-500">Loading…</p>}
          {entries?.length === 0 && <p className="p-2 text-xs text-neutral-500">No earlier versions yet.</p>}
          <ul className="max-h-72 overflow-y-auto">
            {entries?.map((e) => (
              <li key={e.version} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-neutral-900">
                <span className="text-neutral-300 tabular-nums">
                  v{e.version} · {new Date(e.savedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                  <span className="text-neutral-500"> · {e.momentCount} moves</span>
                </span>
                <button type="button" onClick={() => void restore(e.version)} className="text-sky-400 hover:underline">
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RightPanel({ ingest, analysis, onAnalysisChange }: { ingest: Ingest; analysis: Analysis; onAnalysisChange: (a: Analysis) => void }) {
  const [tab, setTab] = useState<'move' | 'cast' | 'subtitles' | 'analysis' | 'ingest'>('move');
  const tabs = [
    ['move', 'Move'],
    ['cast', 'Cast'],
    ['subtitles', 'Subtitles'],
    ['analysis', 'Analysis'],
    ['ingest', 'Ingest'],
  ] as const;
  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900/60">
      <nav className="flex gap-1 border-b border-neutral-800 px-2 pt-2" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px rounded-t-md border-b-2 px-2.5 py-1.5 text-xs font-medium ${
              tab === id ? 'border-sky-400 text-neutral-100' : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'move' && <Inspector />}
        {tab === 'cast' && <CharactersPanel />}
        {tab === 'subtitles' && <SubtitlesPanel />}
        {tab === 'analysis' && <AnalysisPanel analysis={analysis} onStarted={onAnalysisChange} />}
        {tab === 'ingest' && <StageList job={ingest} />}
      </div>
    </section>
  );
}

function ToastView() {
  const toast = useEditor((s) => s.toast);
  const store = useEditorStore();
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => store.getState().dismissToast(), 4000);
    return () => clearTimeout(timer);
  }, [toast, store]);
  if (!toast) return null;
  const tone = { info: 'border-neutral-700', warn: 'border-amber-700', error: 'border-red-700' }[toast.tone];
  return (
    <div
      role="status"
      data-testid="toast"
      className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border ${tone} bg-neutral-950 px-4 py-2 text-sm text-neutral-200 shadow-2xl`}
    >
      {toast.text}
    </div>
  );
}
