import type { Project } from '@als/schema';
import { shotThumbnailFile } from '@als/schema';
import { useEffect, useRef } from 'react';
import { fileUrl } from '../lib/api.ts';
import { formatTime } from '../lib/format.ts';

export interface ShotStripProps {
  project: Project;
  /** Source time currently on screen, in seconds. */
  sourceSec: number;
  onSelect: (sourceSec: number) => void;
}

/** One thumbnail per shot; click to jump to the start of the shot. */
export function ShotStrip({ project, sourceSec, onSelect }: ShotStripProps) {
  const strip = useRef<HTMLDivElement>(null);
  const shots = project.shots ?? [];
  const current = shots.findIndex((s) => sourceSec >= s.start && sourceSec < s.end);

  useEffect(() => {
    strip.current?.children[current]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [current]);

  if (shots.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase">Shots</h2>
      <div ref={strip} className="flex gap-2 overflow-x-auto pb-2">
        {shots.map((shot, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSelect(shot.start)}
            className={`w-32 shrink-0 overflow-hidden rounded-md border text-left transition-colors ${
              i === current ? 'border-sky-400' : 'border-neutral-800 hover:border-neutral-600'
            }`}
          >
            <img
              src={fileUrl(project.id, shotThumbnailFile(i), project.version)}
              alt={`Shot ${i + 1}`}
              loading="lazy"
              className="aspect-video w-full bg-neutral-900 object-cover"
            />
            <div className="flex justify-between px-1.5 py-1 text-[11px] text-neutral-400 tabular-nums">
              <span>{formatTime(shot.start)}</span>
              <span className="text-neutral-600">{(shot.end - shot.start).toFixed(1)}s</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
