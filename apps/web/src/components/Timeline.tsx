import type { Character, EvalBar, EvalBeat, Moment, Shot, Theme, Transcript } from '@als/schema';
import { DEFAULT_START_EVAL, evalFill, evalKeyframes, formatEvalSigned, shotThumbnailFile } from '@als/schema';
import { placeKeyframes, sourceFrameToOut, type Hold, type Timeline as TimelineModel } from '@als/composition';
import { Badge } from '@als/theme';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { SnapKind } from '../editor/snapping.ts';
import { fileUrl } from '../lib/api.ts';
import { formatTime } from '../lib/format.ts';
import { speakerColor } from './editor/speakers.ts';

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
const MIN_TICK_PX = 64;
/** Screen distance within which a dragged block snaps to speech. */
const SNAP_PX = 10;
/** Pointer travel before a press on a block becomes a drag. */
const DRAG_START_PX = 4;

const SNAP_TEXT: Record<SnapKind, string> = { speech: 'end of speech', clean: 'clear of cut', free: 'free (Shift)' };

export interface TimelineProps {
  projectId: string;
  version: number;
  moments: Moment[];
  characters: Character[];
  shots: Shot[];
  transcript: Transcript | undefined;
  timeline: TimelineModel;
  theme: Theme;
  frame: number;
  selectedId: string | null;
  evalBar: EvalBar | undefined;
  onSeek: (frame: number) => void;
  onSelectHold: (hold: Hold) => void;
  onSelectBeat: (beat: EvalBeat, outFrame: number) => void;
  /** The game review's block: shows it, with its panel in the inspector. */
  onSelectGameReview: (outFrame: number) => void;
  onScrubStart?: () => void;
  onRetimeStart: (momentId: string) => void;
  /** Moves a moment to (about) `rawSec`; returns where it actually landed. */
  onRetime: (momentId: string, rawSec: number, options: { snap: boolean; toleranceSec: number }) => { sec: number; kind: SnapKind };
  onRetimeEnd: () => void;
}

/** Output-time timeline: holds as blocks, with shot and speech lanes for context. */
export function Timeline(props: TimelineProps) {
  const { moments, characters, shots, transcript, timeline, theme, frame, onSeek, onScrubStart } = props;
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ id: string; sec: number; kind: SnapKind } | null>(null);
  const { fps, outFrames } = timeline;
  const pct = (outFrame: number) => `${(outFrame / outFrames) * 100}%`;
  const toOut = (sec: number) => sourceFrameToOut(timeline, Math.round(sec * fps));

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const ticks = useMemo(() => {
    const totalSec = outFrames / fps;
    const step = TICK_STEPS.find((s) => (s / totalSec) * width >= MIN_TICK_PX) ?? TICK_STEPS.at(-1)!;
    return Array.from({ length: Math.floor(totalSec / step) + 1 }, (_, i) => i * step);
  }, [outFrames, fps, width]);

  const speakerLabels = useMemo(() => [...new Set(transcript?.utterances.map((u) => u.speaker) ?? [])], [transcript]);
  const speakerName = (label: string) => characters.find((c) => c.speakerLabels.includes(label))?.name ?? `Speaker ${label}`;
  const momentsById = useMemo(() => new Map(moments.map((m) => [m.id, m])), [moments]);
  const actorNames = useMemo(() => new Map(characters.map((c) => [c.id, c.name])), [characters]);
  const evalTrack = useMemo(
    () => placeKeyframes(evalKeyframes(props.evalBar, moments, characters), timeline),
    [props.evalBar, moments, characters, timeline],
  );
  const beatsById = useMemo(() => new Map((props.evalBar?.beats ?? []).map((b) => [b.id, b])), [props.evalBar]);
  // The bar's White share as a step plot over output time, settled values only.
  const barPath = useMemo(() => {
    const y = (fill: number) => ((1 - fill) * 100).toFixed(2);
    let d = `M0,100 V${y(evalFill(props.evalBar?.start ?? DEFAULT_START_EVAL))}`;
    for (const k of evalTrack) d += ` H${k.outFrame} V${y(evalFill(k.eval))}`;
    return `${d} H${outFrames} V100 Z`;
  }, [evalTrack, props.evalBar, outFrames]);

  const frameAt = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (outFrames - 1));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onScrubStart?.();
    onSeek(frameAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) onSeek(frameAt(e.clientX));
  };

  /** Press on a block: a click selects it, a drag retimes it (Shift: no snapping). */
  const onBlockPointerDown = (e: PointerEvent<HTMLButtonElement>, hold: Hold, moment: Moment) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const pxPerSec = (track.current!.getBoundingClientRect().width / outFrames) * fps;
    let dragging = false;
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) < DRAG_START_PX) return;
      if (!dragging) {
        dragging = true;
        props.onRetimeStart(moment.id);
      }
      const landed = props.onRetime(moment.id, moment.sourceTime + dx / pxPerSec, {
        snap: !ev.shiftKey,
        toleranceSec: SNAP_PX / pxPerSec,
      });
      setDrag({ id: moment.id, ...landed });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (dragging) {
        props.onRetimeEnd();
        setDrag(null);
      } else {
        props.onSelectHold(hold);
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div className="mt-3 flex select-none rounded-lg border border-neutral-800 bg-neutral-900/60 text-[11px]">
      <div className="w-16 shrink-0 border-r border-neutral-800 py-1 text-neutral-500">
        <div className="flex h-5 items-center px-2" />
        <div className="flex h-12 items-center px-2">Moves</div>
        <div className="flex h-9 items-center px-2" title="The evaluation bar: White's share, changing at each move and beat">
          Bar
        </div>
        <div className="flex h-10 items-center px-2">Shots</div>
        <div className="flex h-5 items-center px-2">Speech</div>
      </div>

      <div
        ref={track}
        className="relative min-w-0 flex-1 cursor-pointer py-1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        data-testid="timeline-track"
      >
        {/* Ruler, in output time: the length that will export. */}
        <div className="relative h-5 text-neutral-500 tabular-nums">
          {ticks.map((sec) => (
            <div key={sec} className="absolute top-0 h-full border-l border-neutral-700 pl-1" style={{ left: pct(sec * fps) }}>
              {formatTime(sec, 0)}
            </div>
          ))}
        </div>

        {/* Holds, one block per moment, as wide as the hold. Drag to retime. */}
        <div className="relative h-12">
          <div className="absolute inset-x-0 top-1/2 h-px bg-neutral-700" />
          {timeline.holds.map((hold) => {
            const moment = momentsById.get(hold.momentId);
            if (!moment) return null;
            const style = theme.classifications[moment.classification];
            const draft = moment.status === 'draft';
            const actor = moment.actorId ? actorNames.get(moment.actorId) : undefined;
            const active = props.selectedId === hold.momentId;
            const dragging = drag?.id === hold.momentId;
            return (
              <button
                key={hold.momentId}
                type="button"
                data-testid="hold-block"
                data-moment-id={hold.momentId}
                data-out-start={hold.outStart}
                data-frames={hold.frames}
                onPointerDown={(e) => onBlockPointerDown(e, hold, moment)}
                className={`group absolute top-3 bottom-1 cursor-grab rounded-sm outline-offset-1 active:cursor-grabbing ${active ? 'outline-2 outline-white' : ''}`}
                style={{
                  left: pct(hold.outStart),
                  width: pct(hold.frames),
                  background: draft
                    ? `repeating-linear-gradient(135deg, ${style.color} 0 4px, ${style.color}55 4px 8px)`
                    : style.color,
                }}
              >
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full ring-2 ring-neutral-900">
                  <Badge badge={style.badge} color={style.color} size={18} />
                </span>
                {dragging ? (
                  <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-4 w-max -translate-x-1/2 rounded-md border border-sky-700 bg-neutral-950 px-2 py-1 text-xs text-sky-200 tabular-nums" data-testid="drag-tip">
                    {formatTime(drag.sec, 2)} · {SNAP_TEXT[drag.kind]}
                  </span>
                ) : (
                  <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-4 hidden w-max max-w-64 -translate-x-1/2 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-left text-xs text-neutral-200 shadow-lg group-hover:block">
                    <span className="font-semibold" style={{ color: style.color }}>
                      {style.label}
                    </span>
                    {draft && <span className="text-neutral-500"> · draft</span>}
                    <br />
                    {actor && <span className="text-neutral-400">{actor}: </span>}
                    {moment.moveLabel || <span className="text-neutral-500 italic">Untitled move</span>}
                    <br />
                    <span className="text-neutral-500 tabular-nums">
                      at {formatTime(moment.sourceTime)} · holds {(hold.frames / fps).toFixed(1)} s · drag to move
                    </span>
                  </span>
                )}
              </button>
            );
          })}
          {timeline.gameReview && (
            <button
              type="button"
              data-testid="game-review-block"
              data-out-start={timeline.gameReview.outStart}
              data-frames={timeline.gameReview.frames}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button === 0) props.onSelectGameReview(timeline.gameReview!.outStart);
              }}
              title={`Game review · ${(timeline.gameReview.frames / fps).toFixed(1)} s after the last frame`}
              className="absolute top-3 bottom-1 overflow-hidden rounded-sm border border-neutral-600 bg-neutral-800 px-1 text-left text-[10px] leading-7 text-neutral-300 hover:border-neutral-400"
              style={{ left: pct(timeline.gameReview.outStart), width: pct(timeline.gameReview.frames) }}
            >
              Review
            </button>
          )}
        </div>

        {/* The evaluation bar: White's share as a step plot. Solid dots are moves, hollow ones beats. */}
        <div className="relative h-9" data-testid="eval-lane">
          <svg className="absolute inset-y-1 left-0 h-7 w-full" viewBox={`0 0 ${outFrames} 100`} preserveAspectRatio="none">
            <rect x="0" y="0" width={outFrames} height="100" fill="#403d3a" />
            <path d={barPath} fill="#f4f3f1" />
            <line x1="0" x2={outFrames} y1="50" y2="50" stroke="#8a8783" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          </svg>
          {evalTrack.map((k) => {
            const top = `calc(0.25rem + ${(1 - evalFill(k.eval)) * 1.75}rem)`;
            if (k.kind === 'move') {
              const moment = momentsById.get(k.id);
              const color = moment ? theme.classifications[moment.classification].color : '#999';
              return (
                <span
                  key={k.id}
                  className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-neutral-950"
                  style={{ left: pct(k.outFrame), top, background: color }}
                />
              );
            }
            const beat = beatsById.get(k.id);
            if (!beat) return null;
            const actor = beat.actorId ? actorNames.get(beat.actorId) : undefined;
            const active = props.selectedId === beat.id;
            return (
              <button
                key={k.id}
                type="button"
                data-testid="beat-dot"
                data-beat-id={beat.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 0) props.onSelectBeat(beat, k.outFrame);
                }}
                className={`group absolute z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-300 bg-neutral-950 ${active ? 'outline-2 outline-offset-1 outline-white' : ''}`}
                style={{ left: pct(k.outFrame), top }}
              >
                <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-64 -translate-x-1/2 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-left text-xs text-neutral-200 shadow-lg group-hover:block">
                  <span className="font-semibold text-sky-300">Beat {formatEvalSigned(beat.eval)}</span>
                  <br />
                  {actor && <span className="text-neutral-400">{actor}: </span>}
                  {beat.action ?? <span className="text-neutral-500 italic">No description</span>}
                  {beat.reason && (
                    <>
                      <br />
                      <span className="text-neutral-400">{beat.reason}</span>
                    </>
                  )}
                  <br />
                  <span className="text-neutral-500 tabular-nums">at {formatTime(beat.sourceTime)}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* Filmstrip: each shot at its output position, so held shots stretch. */}
        <div className="relative h-10 overflow-hidden">
          {shots.map((shot, i) => {
            const start = toOut(shot.start);
            const end = toOut(shot.end);
            return (
              <div
                key={i}
                className="absolute inset-y-0.5 border-r border-neutral-950 bg-neutral-800"
                style={{
                  left: pct(start),
                  width: pct(end - start),
                  backgroundImage: `url(${fileUrl(props.projectId, shotThumbnailFile(i), props.version)})`,
                  backgroundSize: 'auto 100%',
                  backgroundRepeat: 'repeat-x',
                }}
              />
            );
          })}
        </div>

        {/* Speech, coloured by speaker. */}
        <div className="relative h-5">
          {transcript ? (
            transcript.utterances.map((u) => {
              const start = toOut(u.start);
              return (
                <div
                  key={u.id}
                  title={`${speakerName(u.speaker)}: ${u.text}`}
                  className="absolute top-1 h-3 rounded-sm opacity-80"
                  style={{ left: pct(start), width: pct(Math.max(1, toOut(u.end) - start)), background: speakerColor(speakerLabels, u.speaker) }}
                />
              );
            })
          ) : (
            <span className="absolute inset-0 flex items-center text-neutral-600">No transcript yet</span>
          )}
        </div>

        <div data-testid="playhead" className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white" style={{ left: pct(frame) }} />
      </div>
    </div>
  );
}
