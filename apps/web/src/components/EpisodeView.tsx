import type { EpisodeProps, Project } from '@als/schema';
import { Episode, buildTimeline, sourceFrameToOut, timeMapFrame, type Hold } from '@als/composition';
import { getTheme } from '@als/theme';
import { Player, type PlayerRef } from '@remotion/player';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fileUrl } from '../lib/api.ts';
import { formatTime } from '../lib/format.ts';
import { adjacentHold, holdStopFrame, reviewStop, type PlaybackMode } from '../lib/playback.ts';
import { ShotStrip } from './ShotStrip.tsx';
import { Timeline } from './Timeline.tsx';

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** The episode preview: Remotion Player, transport and timeline. */
export function EpisodeView({ project }: { project: Project }) {
  const player = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<PlaybackMode>('review');
  const { source } = project;
  const fps = source.fps;
  const theme = getTheme(project.themeId);

  const timeline = useMemo(
    () => buildTimeline(project.moments, fps, source.durationSec),
    [project.moments, fps, source.durationSec],
  );

  const inputProps = useMemo<EpisodeProps>(
    () => ({
      src: fileUrl(project.id, source.proxy),
      durationSec: source.durationSec,
      moments: project.moments,
      characters: project.context.characters,
      theme,
    }),
    [project.id, source.proxy, source.durationSec, project.moments, project.context.characters, theme],
  );

  // Event handlers read the latest values through refs, so listeners attach once.
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
    if (import.meta.env.DEV) Object.assign(window, { __alsPlayer: p });
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
  }, []);

  const seek = useCallback(
    (to: number) => {
      const target = Math.min(Math.max(0, Math.round(to)), timeline.outFrames - 1);
      player.current?.seekTo(target);
      setFrame(target);
    },
    [timeline.outFrames],
  );

  const goToHold = useCallback(
    (hold: Hold | undefined) => {
      if (!hold) return;
      player.current?.pause();
      seek(holdStopFrame(hold, timeline, theme));
    },
    [seek, timeline, theme],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const p = player.current;
      if (!p) return;
      const current = p.getCurrentFrame();
      const second = Math.round(fps);
      const handled = (() => {
        switch (e.key.toLowerCase()) {
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
          default:
            return false;
        }
      })();
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, seek, goToHold, timeline, theme]);

  const mapped = timeMapFrame(timeline, frame);
  const heldMoment = mapped.hold ? project.moments[mapped.hold.index] : undefined;

  return (
    <div>
      <div className="overflow-hidden rounded-lg bg-black">
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
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <TransportButton label="Previous moment (P)" onClick={() => goToHold(adjacentHold(frame, -1, timeline, theme))}>
            <Icon d="M7 6v12M18 6l-8 6 8 6z" />
          </TransportButton>
          <TransportButton label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => player.current?.toggle()} wide>
            {playing ? <Icon d="M8 5v14M16 5v14" stroke /> : <Icon d="M8 5.5v13l10.5-6.5z" />}
          </TransportButton>
          <TransportButton label="Next moment (N)" onClick={() => goToHold(adjacentHold(frame, 1, timeline, theme))}>
            <Icon d="M17 6v12M6 6l8 6-8 6z" />
          </TransportButton>
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
        project={project}
        timeline={timeline}
        theme={theme}
        frame={frame}
        onSeek={seek}
        onSelectHold={goToHold}
        onScrubStart={() => player.current?.pause()}
      />

      <p className="mt-2 text-xs text-neutral-600">
        Space play/pause · J/L ±1 s (Shift: ±1 frame) · ←/→ ±1 frame · N/P next/previous moment
      </p>

      <ShotStrip
        project={project}
        sourceSec={mapped.sourceFrame / fps}
        onSelect={(sec) => {
          player.current?.pause();
          seek(sourceFrameToOut(timeline, Math.round(sec * fps)));
        }}
      />
    </div>
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

function TransportButton(props: { label: string; onClick: () => void; wide?: boolean; children: React.ReactNode }) {
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
