import type { Project, Shot } from '@als/schema';
import { shotThumbnailFile } from '@als/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StageList, StatusBadge } from '../components/StageList.tsx';
import { deleteProject, fileUrl, getProject, rerunIngest } from '../lib/api.ts';
import { formatFps, formatTime } from '../lib/format.ts';
import { projectsHref } from '../lib/router.ts';
import { useIngestEvents } from '../lib/useIngestEvents.ts';

const isReady = (project: Project, stage: string) =>
  project.ingest.stages.some((s) => s.name === stage && (s.status === 'done' || s.status === 'cached'));

export function ProjectPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const proxyReady = project !== null && isReady(project, 'proxy');

  const load = useCallback(
    () =>
      getProject(id)
        .then(setProject)
        .catch((e: Error) => setError(e.message)),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useIngestEvents((event) => {
    if (event.projectId !== id) return;
    if (event.ingest.status === 'done' || event.ingest.status === 'error') void load();
    else setProject((p) => (p ? { ...p, ingest: event.ingest } : p));
  });

  // Follow the playhead smoothly while playing; timeupdate alone fires only about 4 times a second.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let frame = 0;
    const tick = () => {
      setTime(el.currentTime);
      if (!el.paused) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    el.addEventListener('play', start);
    el.addEventListener('seeked', tick);
    el.addEventListener('timeupdate', tick);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('play', start);
      el.removeEventListener('seeked', tick);
      el.removeEventListener('timeupdate', tick);
    };
  }, [proxyReady]);

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <a href={projectsHref} className="text-sm text-neutral-400 hover:text-neutral-200">
          ← Projects
        </a>
        <p className="mt-6 text-sm text-red-400">{error}</p>
      </div>
    );
  }
  if (!project) return null;

  const { source } = project;
  const shots = project.shots ?? [];
  const thumbsReady = isReady(project, 'thumbnails');
  const working = project.ingest.status === 'pending' || project.ingest.status === 'running';
  const currentShot = shots.findIndex((s) => time >= s.start && time < s.end);

  const seek = (sec: number) => {
    if (video.current) video.current.currentTime = sec;
  };

  const rerun = async () => {
    setBusy(true);
    try {
      await rerunIngest(id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${project.context.movieTitle || source.originalName || id}” and all its files?`)) return;
    await deleteProject(id);
    window.location.hash = projectsHref;
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <a href={projectsHref} className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Projects
      </a>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {project.context.movieTitle || source.originalName || project.id}
            </h1>
            <StatusBadge ingest={project.ingest} />
          </div>
          <p className="mt-1 text-sm text-neutral-400 tabular-nums">
            {project.context.sceneNote && <span className="text-neutral-300">{project.context.sceneNote} · </span>}
            {formatTime(source.durationSec)} · {source.width}×{source.height} · {formatFps(source.fps)} fps
            {!source.hasAudio && ' · no audio'}
            {shots.length > 0 && ` · ${shots.length} shots`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={rerun}
            disabled={working || busy}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
          >
            Re-run ingest
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={working}
            className="rounded-md border border-neutral-800 px-3 py-1.5 text-sm text-neutral-400 hover:border-red-900 hover:text-red-300 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </header>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_16rem]">
        <div className="min-w-0">
          <div className="overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${source.width} / ${source.height}` }}>
            {proxyReady ? (
              <video
                ref={video}
                src={fileUrl(project.id, source.proxy)}
                controls
                preload="auto"
                className="h-full w-full"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                {project.ingest.status === 'error' ? 'The proxy could not be made.' : 'Making the playback proxy…'}
              </div>
            )}
          </div>

          {shots.length > 0 && proxyReady && (
            <ShotBar shots={shots} duration={source.durationSec} time={time} current={currentShot} onSeek={seek} />
          )}
        </div>

        <aside className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
          <h2 className="mb-3 text-xs font-medium tracking-wide text-neutral-400 uppercase">Ingest</h2>
          <StageList ingest={project.ingest} />
          {project.ingest.error && !project.ingest.stages.some((s) => s.error) && (
            <p className="mt-3 text-xs text-red-300">{project.ingest.error}</p>
          )}
        </aside>
      </div>

      {thumbsReady && shots.length > 0 && (
        <Filmstrip project={project} shots={shots} current={currentShot} onSeek={seek} />
      )}
    </div>
  );
}

/** The whole clip as one bar, split at every detected cut, with the playhead. */
function ShotBar(props: { shots: Shot[]; duration: number; time: number; current: number; onSeek: (t: number) => void }) {
  const { shots, duration, time, current, onSeek } = props;
  return (
    <div
      className="relative mt-3 h-6 cursor-pointer overflow-hidden rounded bg-neutral-900"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * duration);
      }}
    >
      {shots.map((shot, i) => (
        <div
          key={i}
          title={`Shot ${i + 1}: ${formatTime(shot.start)}–${formatTime(shot.end)}`}
          className={`absolute inset-y-0 border-l border-neutral-950 ${
            i === current ? 'bg-sky-700/70' : i % 2 ? 'bg-neutral-700/60' : 'bg-neutral-800'
          }`}
          style={{ left: `${(shot.start / duration) * 100}%`, width: `${((shot.end - shot.start) / duration) * 100}%` }}
        />
      ))}
      <div className="pointer-events-none absolute inset-y-0 w-px bg-white" style={{ left: `${(time / duration) * 100}%` }} />
    </div>
  );
}

function Filmstrip(props: { project: Project; shots: Shot[]; current: number; onSeek: (t: number) => void }) {
  const { project, shots, current, onSeek } = props;
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    strip.current?.children[current]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [current]);

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase">Shots</h2>
      <div ref={strip} className="flex gap-2 overflow-x-auto pb-2">
        {shots.map((shot, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSeek(shot.start)}
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
