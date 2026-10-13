import { CLASSIFICATIONS, episodeProps, speechSnapTargets, type EpisodeProps, type SoundBank } from '@als/schema';
import { Episode, buildTimeline, cardSettledFrame, sourceFrameToOut, timeMapFrame, type Hold } from '@als/composition';
import { Player, type PlayerRef } from '@remotion/player';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { addBeatAt } from '../../editor/bar.ts';
import { EditError, addMoment, deleteBeat, deleteMoment, retime, setClassification, setPortrait, setStatus } from '../../editor/doc.ts';
import { PlaybackProvider, useEditor, useEditorStore, type Playback } from '../../editor/context.tsx';
import { useAutoPlacement } from '../../editor/placement.ts';
import { snapTime } from '../../editor/snapping.ts';
import { createPortrait, fileUrl, getSoundBank } from '../../lib/api.ts';
import { formatTime } from '../../lib/format.ts';
import { adjacentHold, holdStopFrame, reviewStop, type PlaybackMode } from '../../lib/playback.ts';
import { ShotStrip } from '../ShotStrip.tsx';
import { Timeline } from '../Timeline.tsx';
import { EditLayer } from './EditLayer.tsx';
import { PortraitCropper } from './PortraitCropper.tsx';
import { Kbd } from './Inspector.tsx';
import { TranscriptDrawer } from './TranscriptDrawer.tsx';

/** The video's share of the centre column. */
const STAGE_WIDTH = 0.8;
/** Height kept free above and below the video (header, padding, transport) so it fits the viewport. */
const STAGE_VIEWPORT_RESERVE = '9.5rem';

/** How close (s) a move added with M must be to speech to snap to its end. */
const ADD_SNAP_SEC = 0.25;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export interface WorkspaceProps {
  left: ReactNode;
  right: ReactNode;
}

/** Player with the edit layer, transport, timeline and transcript, flanked by the panels. */
export function Workspace({ left, right }: WorkspaceProps) {
  const store = useEditorStore();
  useAutoPlacement();
  const project = useEditor((s) => s.project);
  const moments = useEditor((s) => s.doc.moments);
  const characters = useEditor((s) => s.doc.characters);
  const theme = useEditor((s) => s.theme);
  const selectedId = useEditor((s) => s.selectedId);
  const evalBar = useEditor((s) => s.doc.evalBar);
  const editedSubtitles = useEditor((s) => s.doc.subtitles);
  const evalBarScale = useEditor((s) => s.doc.evalBarScale);
  const portraitCrop = useEditor((s) => s.portraitCrop);
  const [cropping, setCropping] = useState(false);
  const player = useRef<PlayerRef>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [mode, setMode] = useState<PlaybackMode>('review');
  const [scale, setScale] = useState(0);
  const { source } = project;
  const fps = source.fps;
  const shots = useMemo(() => project.shots ?? [], [project.shots]);
  const [sounds, setSounds] = useState<SoundBank>();
  useEffect(() => {
    // Sounds are optional: without them the Player has only the clip's audio.
    getSoundBank().then(setSounds, (error: unknown) => console.warn('no chess sounds:', error));
  }, []);

  const timeline = useMemo(() => buildTimeline(moments, fps, source.durationSec), [moments, fps, source.durationSec]);
  const snapTargets = useMemo(
    () => speechSnapTargets(project.transcript?.words ?? [], shots, fps),
    [project.transcript, shots, fps],
  );

  const inputProps = useMemo<EpisodeProps>(
    () =>
      episodeProps(
        { durationSec: source.durationSec, moments, characters, evalBar, evalBarScale, subtitles: editedSubtitles, transcript: project.transcript },
        { src: fileUrl(project.id, source.proxy), theme, fileUrl: (file) => fileUrl(project.id, file), sounds },
      ),
    [project.id, source.proxy, source.durationSec, moments, characters, theme, evalBar, evalBarScale, sounds, editedSubtitles, project.transcript],
  );

  // Handlers attached once read the latest values here.
  const live = useRef({ mode, timeline, theme, playing });
  useEffect(() => {
    live.current = { mode, timeline, theme, playing };
  });

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    let prev = p.getCurrentFrame();
    const onFrame = (e: { detail: { frame: number } }) => {
      const next = e.detail.frame;
      const { mode, timeline, theme } = live.current;
      // Review mode: stop at each hold once the card is in, so it can be read and edited.
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
    // Dev-only handle for browser-driven checks.
    if (import.meta.env.DEV) Object.assign(window, { __alsPlayer: p, __alsEditor: store });
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [store]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setScale(entry!.contentRect.width / source.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [source.width]);

  const seek = useCallback((to: number) => {
    const target = Math.min(Math.max(0, Math.round(to)), live.current.timeline.outFrames - 1);
    player.current?.seekTo(target);
    setFrame(target);
  }, []);
  const pause = useCallback(() => player.current?.pause(), []);

  const goToHold = useCallback(
    (hold: Hold | undefined) => {
      if (!hold) return;
      player.current?.pause();
      seek(holdStopFrame(hold, live.current.timeline, live.current.theme));
    },
    [seek],
  );
  const goToMoment = useCallback(
    (id: string) => goToHold(live.current.timeline.holds.find((h) => h.momentId === id)),
    [goToHold],
  );

  const currentHold = timeline.holds.find((h) => frame >= h.outStart && frame < h.outStart + h.frames);
  const editableHold = !playing && !scrubbing ? currentHold : undefined;
  const editableMoment = editableHold ? moments[editableHold.index] : undefined;

  // While paused on a card, keep the playhead on it as edits reshape the timeline
  // (its own hold growing, earlier moves added or retimed, a drag in progress).
  const anchor = useRef<{ momentId: string; offset: number } | null>(null);
  useEffect(() => {
    const a = anchor.current;
    if (!a || live.current.playing) return;
    const hold = timeline.holds.find((h) => h.momentId === a.momentId);
    if (!hold) return;
    const target = hold.outStart + Math.min(a.offset, hold.frames - 1);
    if (target !== player.current?.getCurrentFrame()) seek(target);
  }, [timeline, seek]);
  useEffect(() => {
    // Leaving the hold (playing, or the playhead moved off it) drops the anchor, so a
    // later edit never pulls the playhead back to a card it has left.
    anchor.current = !playing && editableHold ? { momentId: editableHold.momentId, offset: frame - editableHold.outStart } : null;
    // Only frame moves re-anchor; timeline changes are followed above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, playing]);

  // Cropping a portrait works on a still frame.
  useEffect(() => {
    if (portraitCrop) player.current?.pause();
  }, [portraitCrop]);

  // The card on screen is the selected move.
  useEffect(() => {
    if (editableHold && store.getState().selectedId !== editableHold.momentId) store.getState().select(editableHold.momentId);
  }, [editableHold, store]);

  const addAtPlayhead = useCallback(() => {
    const { timeline } = live.current;
    const at = timeMapFrame(timeline, player.current?.getCurrentFrame() ?? 0);
    if (at.hold) {
      store.getState().notify('There is already a move here.', 'warn');
      return;
    }
    const { sec } = snapTime(at.sourceFrame / fps, { targets: snapTargets, shots, fps }, true, ADD_SNAP_SEC);
    try {
      let id = '';
      store.getState().edit((d) => {
        const added = addMoment(d, { sourceTime: sec }, store.getState().theme, source.durationSec);
        id = added.id;
        return added.doc;
      });
      player.current?.pause();
      store.getState().select(id);
      requestAnimationFrame(() => {
        goToMoment(id);
        store.getState().requestFocus(id, 'moveLabel');
      });
    } catch (error) {
      if (error instanceof EditError) store.getState().notify(error.message, 'warn');
      else throw error;
    }
  }, [store, fps, snapTargets, shots, source.durationSec, goToMoment]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = store.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === 'z' || key === 'y')) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (isTyping(e.target) || mod || e.altKey) return;
      const p = player.current;
      if (!p) return;
      const current = p.getCurrentFrame();
      const second = Math.round(fps);
      const { timeline, theme } = live.current;
      const target = s.selectedId;
      const digit = /^[0-9]$/.test(e.key) ? (Number(e.key) + 9) % 10 : -1;
      const handled = (() => {
        if (digit >= 0) {
          if (target && s.doc.moments.some((m) => m.id === target)) s.edit((d) => setClassification(d, target, CLASSIFICATIONS[digit]!));
          return true;
        }
        switch (key) {
          case ' ':
            p.toggle();
            return true;
          case 'k':
            p.pause();
            return true;
          case 'j':
            seek(current - (e.shiftKey ? 1 : second));
            return true;
          case 'l':
            seek(current + (e.shiftKey ? 1 : second));
            return true;
          case 'arrowleft':
            seek(current - (e.shiftKey ? second : 1));
            return true;
          case 'arrowright':
            seek(current + (e.shiftKey ? second : 1));
            return true;
          case 'n':
            goToHold(adjacentHold(current, 1, timeline, theme));
            return true;
          case 'p':
            goToHold(adjacentHold(current, -1, timeline, theme));
            return true;
          case 'home':
            seek(0);
            return true;
          case 'end':
            seek(timeline.outFrames - 1);
            return true;
          case 'm':
            addAtPlayhead();
            return true;
          case 'b':
            addBeatAt(store, timeMapFrame(timeline, current).sourceFrame / fps);
            return true;
          case 'a': {
            const m = s.doc.moments.find((x) => x.id === target);
            if (m) s.edit((d) => setStatus(d, [m.id], m.status === 'approved' ? 'draft' : 'approved'));
            return true;
          }
          case 'delete':
          case 'backspace':
            if (target && s.doc.evalBar?.beats.some((b) => b.id === target)) {
              s.edit((d) => deleteBeat(d, target));
              s.select(null);
              s.notify('Beat deleted. Undo with ⌘Z / Ctrl+Z.');
            } else if (target) {
              s.edit((d) => deleteMoment(d, target));
              s.select(null);
              s.notify('Move deleted. Undo with ⌘Z / Ctrl+Z.');
            }
            return true;
          default:
            return false;
        }
      })();
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, fps, seek, goToHold, addAtPlayhead]);

  const playback: Playback = { player, timeline, fps, frame, playing, seek, pause, goToMoment, editableHold };
  const mapped = timeMapFrame(timeline, frame);
  const heldMoment = mapped.hold ? moments[mapped.hold.index] : undefined;
  const hasMoments = moments.length > 0;

  return (
    <PlaybackProvider value={playback}>
      <div className="grid gap-4 xl:grid-cols-[16rem_minmax(0,1fr)_20rem]">
        <div className="order-2 min-h-0 xl:order-none xl:max-h-[calc(100vh-7rem)]">{left}</div>

        <div className="min-w-0">
          {/* 80% of the column, and never taller than the viewport allows, so the whole
              frame and its card are always visible without scrolling the page. */}
          <div
            ref={stage}
            className="relative mx-auto overflow-hidden rounded-lg bg-black"
            style={{ width: `min(${STAGE_WIDTH * 100}%, calc((100dvh - ${STAGE_VIEWPORT_RESERVE}) * ${source.width / source.height}))` }}
            data-testid="stage"
          >
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
              style={{ width: '100%', aspectRatio: `${source.width} / ${source.height}` }}
            />
            {editableMoment && scale > 0 && !portraitCrop && (
              <EditLayer moment={editableMoment} width={source.width} height={source.height} scale={scale} />
            )}
            {portraitCrop && (
              <PortraitCropper
                name={characters.find((c) => c.id === portraitCrop)?.name ?? ''}
                aspect={source.width / source.height}
                busy={cropping}
                onCancel={() => store.getState().setPortraitCrop(null)}
                onUse={(square) => {
                  const characterId = portraitCrop;
                  const sourceTime = timeMapFrame(timeline, frame).sourceFrame / fps;
                  setCropping(true);
                  createPortrait(project.id, { characterId, sourceTime, ...square })
                    .then((file) => {
                      store.getState().edit((d) => setPortrait(d, characterId, file));
                      store.getState().setPortraitCrop(null);
                    })
                    .catch((e: unknown) => store.getState().notify(`Could not crop the portrait: ${e instanceof Error ? e.message : String(e)}`, 'error'))
                    .finally(() => setCropping(false));
                }}
              />
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              {hasMoments && (
                <TransportButton label="Previous move (P)" onClick={() => goToHold(adjacentHold(frame, -1, timeline, theme))}>
                  <Icon d="M7 6v12M18 6l-8 6 8 6z" />
                </TransportButton>
              )}
              <TransportButton label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => player.current?.toggle()} wide>
                {playing ? <Icon d="M8 5v14M16 5v14" stroke /> : <Icon d="M8 5.5v13l10.5-6.5z" />}
              </TransportButton>
              {hasMoments && (
                <TransportButton label="Next move (N)" onClick={() => goToHold(adjacentHold(frame, 1, timeline, theme))}>
                  <Icon d="M17 6v12M6 6l8 6-8 6z" />
                </TransportButton>
              )}
            </div>

            <div className="text-sm tabular-nums text-neutral-300" data-testid="clock">
              {formatTime(frame / fps)} <span className="text-neutral-600">/ {formatTime(timeline.outFrames / fps)}</span>
              <span className="ml-3 text-xs text-neutral-500">
                source {formatTime(mapped.sourceFrame / fps)} · frame {frame}
              </span>
            </div>

            {heldMoment && (
              <span
                className="rounded-full px-2 py-0.5 text-xs font-medium text-neutral-950"
                style={{ background: theme.classifications[heldMoment.classification].color }}
                data-testid="hold-chip"
              >
                Hold · {theme.classifications[heldMoment.classification].label}
              </span>
            )}

            <div className="ml-auto flex rounded-md border border-neutral-700 p-0.5 text-xs" role="radiogroup" aria-label="Playback mode">
              {(['review', 'preview'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  title={m === 'review' ? 'Pause at every hold to read and edit the card' : 'Play straight through, exactly as the MP4 will'}
                  className={`rounded px-2.5 py-1 capitalize ${mode === m ? 'bg-neutral-200 text-neutral-950' : 'text-neutral-400 hover:text-neutral-200'}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <Timeline
            projectId={project.id}
            version={project.version}
            moments={moments}
            characters={characters}
            shots={shots}
            transcript={project.transcript}
            timeline={timeline}
            theme={theme}
            frame={frame}
            selectedId={selectedId}
            evalBar={evalBar}
            onSeek={seek}
            onSelectBeat={(beat, outFrame) => {
              player.current?.pause();
              store.getState().select(beat.id);
              seek(outFrame);
            }}
            onSelectHold={(hold) => {
              store.getState().select(hold.momentId);
              goToHold(hold);
            }}
            onScrubStart={() => {
              player.current?.pause();
              setScrubbing(true);
              window.addEventListener('pointerup', () => setScrubbing(false), { once: true });
            }}
            onRetimeStart={(id) => {
              player.current?.pause();
              store.getState().select(id);
              const hold = live.current.timeline.holds.find((h) => h.momentId === id);
              anchor.current = { momentId: id, offset: hold ? cardSettledFrame(hold.frames, fps, theme.timing) : 0 };
              store.getState().beginGesture();
            }}
            onRetime={(id, raw, { snap, toleranceSec }) => {
              const snapped = snapTime(raw, { targets: snapTargets, shots, fps }, snap, toleranceSec);
              store.getState().gesture((d) => retime(d, id, snapped.sec, source.durationSec));
              const landed = store.getState().doc.moments.find((m) => m.id === id)!.sourceTime;
              return { sec: landed, kind: landed === snapped.sec ? snapped.kind : 'free' };
            }}
            onRetimeEnd={() => store.getState().endGesture()}
          />

          <p className="mt-2 text-xs text-neutral-600">
            <Kbd>Space</Kbd> play · <Kbd>J</Kbd>/<Kbd>L</Kbd> ±1 s · <Kbd>←</Kbd>/<Kbd>→</Kbd> ±1 frame
            {hasMoments && (
              <>
                {' '}
                · <Kbd>N</Kbd>/<Kbd>P</Kbd> next/previous move · <Kbd>1</Kbd>–<Kbd>0</Kbd> rating · <Kbd>A</Kbd> approve ·{' '}
                <Kbd>Del</Kbd> delete
              </>
            )}{' '}
            · <Kbd>M</Kbd> add move · <Kbd>B</Kbd> add beat · <Kbd>⌘Z</Kbd> undo · drag a block to move it (<Kbd>Shift</Kbd>: no snapping)
          </p>

          <TranscriptDrawer />

          <ShotStrip
            project={project}
            sourceSec={mapped.sourceFrame / fps}
            onSelect={(sec) => {
              player.current?.pause();
              seek(sourceFrameToOut(timeline, Math.round(sec * fps)));
            }}
          />
        </div>

        <div className="order-3 min-h-0 xl:order-none xl:max-h-[calc(100vh-7rem)]">{right}</div>
      </div>
    </PlaybackProvider>
  );
}

function Icon({ d, stroke = false }: { d: string; stroke?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true">
      <path
        d={d}
        fill={stroke ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={stroke ? 3 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TransportButton(props: { label: string; onClick: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      className={`flex h-8 items-center justify-center rounded-md border border-neutral-700 text-sm text-neutral-200 hover:border-neutral-500 ${props.wide ? 'w-12' : 'w-9'}`}
    >
      {props.children}
    </button>
  );
}
