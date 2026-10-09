import type { Project } from '@als/schema';
import { useCallback, useEffect, useState } from 'react';
import { EpisodeView } from '../components/EpisodeView.tsx';
import { StageList, StatusBadge } from '../components/StageList.tsx';
import { deleteProject, getProject, rerunIngest } from '../lib/api.ts';
import { formatFps, formatTime } from '../lib/format.ts';
import { projectsHref } from '../lib/router.ts';
import { useIngestEvents } from '../lib/useIngestEvents.ts';

const isReady = (project: Project, stage: string) =>
  project.ingest.stages.some((s) => s.name === stage && (s.status === 'done' || s.status === 'cached'));

export function ProjectPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const proxyReady = isReady(project, 'proxy');
  const working = project.ingest.status === 'pending' || project.ingest.status === 'running';

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

      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_15rem]">
        <div className="min-w-0">
          {proxyReady && !working ? (
            <EpisodeView project={project} />
          ) : (
            <div
              className="flex items-center justify-center rounded-lg bg-black text-sm text-neutral-500"
              style={{ aspectRatio: `${source.width} / ${source.height}` }}
            >
              {project.ingest.status === 'error' ? 'The proxy could not be made.' : 'Preparing the clip…'}
            </div>
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

    </div>
  );
}
