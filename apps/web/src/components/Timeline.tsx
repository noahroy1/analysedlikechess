import type { Project, Theme } from '@als/schema';
import { shotThumbnailFile } from '@als/schema';
import { sourceFrameToOut, type Hold, type Timeline as TimelineModel } from '@als/composition';
import { Badge } from '@als/theme';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { fileUrl } from '../lib/api.ts';
import { formatTime } from '../lib/format.ts';

const SPEAKER_COLORS = ['#7dd3fc', '#fca5a5', '#c4b5fd', '#fcd34d', '#86efac', '#f9a8d4', '#fdba74', '#a5b4fc'];
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
const MIN_TICK_PX = 64;

export interface TimelineProps {
  project: Project;
  timeline: TimelineModel;
  theme: Theme;
  frame: number;
  onSeek: (frame: number) => void;
  onSelectHold: (hold: Hold) => void;
  onScrubStart?: () => void;
}

/** Output-time timeline: holds as blocks, with shot and speech lanes for context. */
export function Timeline({ project, timeline, theme, frame, onSeek, onSelectHold, onScrubStart }: TimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
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

  const speakers = useMemo(() => {
    const labels = [...new Set(project.transcript?.utterances.map((u) => u.speaker) ?? [])];
    const names = new Map(project.context.characters.flatMap((c) => c.speakerLabels.map((l) => [l, c.name] as const)));
    return new Map(labels.map((label, i) => [label, { color: SPEAKER_COLORS[i % SPEAKER_COLORS.length]!, name: names.get(label) ?? label }]));
  }, [project.transcript, project.context.characters]);

  const momentsById = useMemo(() => new Map(project.moments.map((m) => [m.id, m])), [project.moments]);
  const actorNames = useMemo(() => new Map(project.context.characters.map((c) => [c.id, c.name])), [project.context.characters]);

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

  const currentHold = timeline.holds.find((h) => frame >= h.outStart && frame < h.outStart + h.frames);
  const shots = project.shots ?? [];

  return (
    <div className="mt-3 flex select-none rounded-lg border border-neutral-800 bg-neutral-900/60 text-[11px]">
      <div className="w-16 shrink-0 border-r border-neutral-800 py-1 text-neutral-500">
        <div className="flex h-5 items-center px-2" />
        <div className="flex h-12 items-center px-2">Moves</div>
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

        {/* Holds, one block per moment, as wide as the hold. */}
        <div className="relative h-12">
          <div className="absolute inset-x-0 top-1/2 h-px bg-neutral-700" />
          {timeline.holds.map((hold) => {
            const moment = momentsById.get(hold.momentId)!;
            const style = theme.classifications[moment.classification];
            const draft = moment.status === 'draft';
            const actor = moment.actorId ? actorNames.get(moment.actorId) : undefined;
            const active = currentHold === hold;
            return (
              <button
                key={hold.momentId}
                type="button"
                data-testid="hold-block"
                data-moment-id={hold.momentId}
                data-out-start={hold.outStart}
                data-frames={hold.frames}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onSelectHold(hold)}
                className={`group absolute top-3 bottom-1 rounded-sm outline-offset-1 ${active ? 'outline-2 outline-white' : ''}`}
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
                <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-4 hidden w-max max-w-64 -translate-x-1/2 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-left text-xs text-neutral-200 shadow-lg group-hover:block">
                  <span className="font-semibold" style={{ color: style.color }}>
                    {style.label}
                  </span>
                  {draft && <span className="text-neutral-500"> · draft</span>}
                  <br />
                  {actor && <span className="text-neutral-400">{actor}: </span>}
                  {moment.moveLabel}
                  <br />
                  <span className="text-neutral-500 tabular-nums">
                    at {formatTime(moment.sourceTime)} · holds {(hold.frames / fps).toFixed(1)} s
                  </span>
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
                  backgroundImage: `url(${fileUrl(project.id, shotThumbnailFile(i), project.version)})`,
                  backgroundSize: 'auto 100%',
                  backgroundRepeat: 'repeat-x',
                }}
              />
            );
          })}
        </div>

        {/* Speech, coloured by speaker. */}
        <div className="relative h-5">
          {project.transcript ? (
            project.transcript.utterances.map((u) => {
              const start = toOut(u.start);
              const speaker = speakers.get(u.speaker)!;
              return (
                <div
                  key={u.id}
                  title={`${speaker.name}: ${u.text}`}
                  className="absolute top-1 h-3 rounded-sm opacity-80"
                  style={{ left: pct(start), width: pct(Math.max(1, toOut(u.end) - start)), background: speaker.color }}
                />
              );
            })
          ) : (
            <span className="absolute inset-0 flex items-center text-neutral-600">No transcript yet</span>
          )}
        </div>

        <div
          data-testid="playhead"
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white"
          style={{ left: pct(frame) }}
        />
      </div>
    </div>
  );
}
