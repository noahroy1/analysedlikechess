import { Episode, buildTimeline, type Hold } from '@als/composition';
import {
  adoptProjectLook,
  createEditorStore,
  holdStopFrame,
  reviewStop,
  setStatus,
  type EditorActions,
  type EditorState,
  type EditorStore,
  type PlaybackMode,
} from '@als/editor-core';
import { episodeProps, gameReviewSec, projectName, type Analysis, type EpisodeProps, type Project, type SoundBank } from '@als/schema';
import { Badge, PROJECT_THEME_ID, getTheme } from '@als/theme';
import { App as CapApp } from '@capacitor/app';
import { Player, type PlayerRef } from '@remotion/player';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { api } from '../lib/api.ts';
import { formatTime } from '../lib/format.ts';
import { projectsHref } from '../lib/router.ts';
import { MoveSheet } from './MoveSheet.tsx';
import { RenderSheet } from './RenderSheet.tsx';

const StoreContext = createContext<EditorStore | null>(null);

export function useEditorStore(): EditorStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useEditor outside <Editor>');
  return store;
}

/** One slice of editor state. Select stable values, not new objects. */
export function useEditor<T>(selector: (state: EditorState & EditorActions) => T): T {
  return useStore(useEditorStore(), selector);
}

/**
 * The phone's editor (PLAN-CLOUD.md, C5 scope): watch the drafts over the Player with holds and
 * sounds, and light edits (rating, text, approve, delete) through the same store, undo and autosave
 * as the desktop editor. Retiming, placement, the bar and the rest stay on desktop.
 */
export function Editor({ project, analysis, analysisEnded, mediaUntil }: { project: Project; analysis: Analysis; analysisEnded: number; mediaUntil: string | undefined }) {
  const [store] = useState<EditorStore>(() =>
    createEditorStore(project, {
      save: (edit) => api.saveProject(project.id, edit),
      reload: () => api.getProject(project.id),
    }),
  );

  useEffect(() => {
    store.getState().activate();
    const { width, height } = store.getState().project.source;
    // One look for every project, as the desktop editor does: a plain save, not an undo step.
    if (store.getState().doc.themeId !== PROJECT_THEME_ID) {
      store.getState().amend((d) => adoptProjectLook(d, { width, height }));
      store.getState().notify(`This project now uses the ${getTheme(PROJECT_THEME_ID).name} look.`);
    }
    // iOS may end a backgrounded app without warning: save on the way out.
    const away = CapApp.addListener('pause', () => void store.getState().flush());
    return () => {
      void away.then((h) => h.remove());
      void store.getState().flush();
      store.getState().dispose();
    };
  }, [store]);

  // An analysis ended (ProjectPage counts them): its drafts are in the project. Save anything pending, then load them.
  const seenEnded = useRef(analysisEnded);
  const succeeded = analysis.status === 'done';
  useEffect(() => {
    if (seenEnded.current === analysisEnded) return;
    seenEnded.current = analysisEnded;
    void store
      .getState()
      .flush()
      .then(() => store.getState().reload())
      .then(() => {
        if (!succeeded) return;
        const count = store.getState().doc.moments.filter((m) => m.origin === 'ai' && m.status === 'draft').length;
        store.getState().notify(`Drafts ready: ${count} move${count === 1 ? '' : 's'} to review.`);
      });
  }, [analysisEnded, succeeded, store]);

  return (
    <StoreContext.Provider value={store}>
      <EditorBody drafting={analysis.status === 'pending' || analysis.status === 'running'} mediaUntil={mediaUntil} />
    </StoreContext.Provider>
  );
}

const SAVE_TEXT: Record<EditorState['saveStatus'], string> = { saved: 'Saved', pending: 'Saving…', saving: 'Saving…', invalid: 'Can’t save', error: 'Not saved' };

function EditorBody({ drafting, mediaUntil }: { drafting: boolean; mediaUntil: string | undefined }) {
  const store = useEditorStore();
  const project = useEditor((s) => s.project);
  const moments = useEditor((s) => s.doc.moments);
  const characters = useEditor((s) => s.doc.characters);
  const theme = useEditor((s) => s.theme);
  const evalBar = useEditor((s) => s.doc.evalBar);
  const evalBarScale = useEditor((s) => s.doc.evalBarScale);
  const subtitles = useEditor((s) => s.doc.subtitles);
  const gameReview = useEditor((s) => s.doc.gameReview);
  const title = useEditor((s) => s.doc.title);
  const saveStatus = useEditor((s) => s.saveStatus);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const selectedId = useEditor((s) => s.selectedId);
  const { source } = project;
  const fps = source.fps;

  const [sounds, setSounds] = useState<SoundBank>();
  useEffect(() => {
    api.getSoundBank().then(setSounds, (error: unknown) => console.warn('no chess sounds:', error));
  }, []);

  const timeline = useMemo(() => buildTimeline(moments, fps, source.durationSec, gameReviewSec(theme)), [moments, fps, source.durationSec, theme]);
  const inputProps = useMemo<EpisodeProps>(
    () =>
      episodeProps(
        { durationSec: source.durationSec, moments, characters, evalBar, evalBarScale, subtitles, transcript: project.transcript, gameReview },
        { src: api.fileUrl(project.id, source.proxy), theme, fileUrl: (file) => api.fileUrl(project.id, file), sounds },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mediaUntil changes what fileUrl returns
    [project.id, mediaUntil, source.proxy, source.durationSec, moments, characters, theme, evalBar, evalBarScale, sounds, subtitles, project.transcript, gameReview],
  );

  const player = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<PlaybackMode>('review');
  const [sheet, setSheet] = useState<'move' | 'render' | null>(null);

  const live = useRef({ mode, timeline, theme });
  useEffect(() => {
    live.current = { mode, timeline, theme };
  });

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    let prev = p.getCurrentFrame();
    const onFrame = (e: { detail: { frame: number } }) => {
      const next = e.detail.frame;
      const { mode, timeline, theme } = live.current;
      // Review: stop at each card once it is in, to read it and tap Edit.
      const stop = mode === 'review' && p.isPlaying() ? reviewStop(prev, next, timeline, theme) : undefined;
      if (stop !== undefined) {
        p.pause();
        p.seekTo(stop);
        prev = stop;
        setFrame(stop);
        return;
      }
      prev = next;
      setFrame(next);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    if (import.meta.env.VITE_CHECK_HOOKS === 'true') Object.assign(window, { __alsPlayer: p, __alsEditor: store });
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [store]);

  const seek = useCallback((to: number) => {
    const target = Math.min(Math.max(0, Math.round(to)), live.current.timeline.outFrames - 1);
    player.current?.seekTo(target);
    setFrame(target);
  }, []);

  const holdOf = (id: string | null): Hold | undefined => (id ? timeline.holds.find((h) => h.momentId === id) : undefined);
  const goTo = (id: string) => {
    const hold = holdOf(id);
    if (!hold) return;
    player.current?.pause();
    seek(holdStopFrame(hold, timeline, theme));
  };
  const openMove = (id: string) => {
    store.getState().select(id);
    goTo(id);
    setSheet('move');
  };

  // While a card is being edited, its hold changes length with the text: keep the playhead on it.
  const editingHold = sheet === 'move' ? holdOf(selectedId) : undefined;
  useEffect(() => {
    if (!editingHold || playing) return;
    const stop = holdStopFrame(editingHold, timeline, theme);
    if (frame < editingHold.outStart || frame >= editingHold.outStart + editingHold.frames) seek(stop);
  }, [editingHold, timeline, theme, frame, playing, seek]);

  const pausedHold = !playing ? timeline.holds.find((h) => frame >= h.outStart && frame < h.outStart + h.frames) : undefined;
  const sorted = useMemo(() => [...moments].sort((a, b) => a.sourceTime - b.sourceTime), [moments]);
  const drafts = sorted.filter((m) => m.status === 'draft');
  const aspect = source.width / source.height;

  const togglePlay = () => {
    const p = player.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else {
      if (frame >= timeline.outFrames - 1) seek(0);
      p.play();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 px-3 pt-2 pb-1.5">
        <a
          href={projectsHref}
          className="btn-quiet shrink-0 px-1"
          onClick={(e) => {
            e.preventDefault();
            void store.getState().flush().finally(() => (window.location.hash = projectsHref));
          }}
        >
          ‹
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{projectName({ ...project, ...(title ? { title } : {}) })}</h1>
          <p className={`text-[11px] ${saveStatus === 'error' || saveStatus === 'invalid' ? 'text-red-400' : 'text-neutral-500'}`} data-testid="save-status">
            {SAVE_TEXT[saveStatus]}
          </p>
        </div>
        <button type="button" className="btn-quiet px-2" disabled={!canUndo} onClick={() => store.getState().undo()} aria-label="Undo">
          ↶
        </button>
        <button type="button" className="btn-quiet px-2" disabled={!canRedo} onClick={() => store.getState().redo()} aria-label="Redo">
          ↷
        </button>
        <button type="button" className="btn px-3 py-1.5 text-xs" onClick={() => (player.current?.pause(), setSheet('render'))}>
          Render
        </button>
      </header>

      <div className="mx-auto w-full overflow-hidden bg-black" style={{ width: `min(100%, calc(52dvh * ${aspect}))` }} data-testid="stage">
        <div className="relative">
          <Player
            ref={player}
            component={Episode}
            inputProps={inputProps}
            durationInFrames={timeline.outFrames}
            fps={fps}
            compositionWidth={source.width}
            compositionHeight={source.height}
            controls={false}
            clickToPlay={false}
            doubleClickToFullscreen={false}
            spaceKeyToPlayOrPause={false}
            moveToBeginningWhenEnded={false}
            acknowledgeRemotionLicense
            style={{ width: '100%', aspectRatio: `${source.width} / ${source.height}` }}
          />
          <button type="button" className="absolute inset-0" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay} />
        </div>
      </div>

      <div className="px-3 pt-2">
        <input
          type="range"
          min={0}
          max={Math.max(0, timeline.outFrames - 1)}
          value={frame}
          onChange={(e) => (player.current?.pause(), seek(Number(e.target.value)))}
          className="w-full accent-sky-400"
          aria-label="Position"
        />
        <div className="flex items-center gap-3 text-xs text-neutral-400">
          <button type="button" className="btn px-4 py-1.5 text-xs" onClick={togglePlay} data-testid="play">
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="tabular-nums">
            {formatTime(frame / fps)} / {formatTime(timeline.outFrames / fps)}
          </span>
          <label className="ml-auto flex items-center gap-1.5">
            <input type="checkbox" checked={mode === 'review'} onChange={(e) => setMode(e.target.checked ? 'review' : 'preview')} />
            Stop at cards
          </label>
        </div>
        {pausedHold && (
          <button type="button" className="btn-primary mt-2 w-full" onClick={() => openMove(pausedHold.momentId)} data-testid="edit-card">
            Edit this card
          </button>
        )}
      </div>

      {drafting && <p className="mx-3 mt-2 rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2 text-xs text-sky-200">Drafting moves… they load here when ready.</p>}

      <section className="mt-2 flex-1 overflow-y-auto px-3 pb-6 safe-bottom">
        <div className="flex items-center justify-between py-1">
          <h2 className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
            Moves · {sorted.length - drafts.length}/{sorted.length} approved
          </h2>
          {drafts.length > 0 && (
            <button type="button" className="btn-quiet text-xs" onClick={() => store.getState().edit((d) => setStatus(d, drafts.map((m) => m.id), 'approved'))}>
              Approve all
            </button>
          )}
        </div>
        <ul className="flex flex-col gap-1.5" data-testid="moves">
          {sorted.map((m, i) => {
            const style = theme.classifications[m.classification];
            const current = pausedHold?.momentId === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => openMove(m.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left ${current ? 'border-sky-700 bg-sky-950/30' : 'border-neutral-800 bg-neutral-900/60'} active:bg-neutral-800`}
                >
                  <Badge badge={style.badge} color={style.color} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{m.moveLabel || style.label}</span>
                    <span className="block text-[11px] text-neutral-500 tabular-nums">
                      {i + 1} · {style.label} · {formatTime(m.sourceTime)}
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${m.status === 'approved' ? 'bg-emerald-950 text-emerald-300' : 'bg-neutral-800 text-neutral-400'}`}>
                    {m.status === 'approved' ? 'Approved' : 'Draft'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {sheet === 'move' && selectedId && <MoveSheet id={selectedId} onClose={() => setSheet(null)} />}
      {sheet === 'render' && <RenderSheet onClose={() => setSheet(null)} />}
      <ToastView />
    </div>
  );
}

function ToastView() {
  const store = useEditorStore();
  const toast = useEditor((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => store.getState().dismissToast(), 4000);
    return () => clearTimeout(timer);
  }, [toast, store]);
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 safe-bottom">
      <p className={`mb-16 rounded-lg px-3 py-2 text-xs shadow-lg ${toast.tone === 'error' ? 'bg-red-900 text-red-100' : toast.tone === 'warn' ? 'bg-amber-900 text-amber-100' : 'bg-neutral-800 text-neutral-100'}`}>{toast.text}</p>
    </div>
  );
}
