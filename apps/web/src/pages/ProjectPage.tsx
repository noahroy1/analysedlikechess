import type { Analysis, Ingest, Project } from '@als/schema';
import { useCallback, useEffect, useState } from 'react';
import { EditorRoot } from '../components/editor/EditorRoot.tsx';
import { StageList, StatusBadge } from '../components/StageList.tsx';
import { deleteProject, getProject, rerunIngest } from '../lib/api.ts';
import { formatFps, formatTime } from '../lib/format.ts';
import { projectsHref } from '../lib/router.ts';
import { useProjectEvents } from '../lib/useProjectEvents.ts';

const isReady = (project: Project) =>
  project.ingest.status === 'done' &&
  project.ingest.stages.some((s) => s.name === 'proxy' && (s.status === 'done' || s.status === 'cached'));

/** Ingest progress until the clip is ready, then the editor. */
export function ProjectPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [ingest, setIngest] = useState<Ingest | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      getProject(id)
        .then((p) => {
          setProject(p);
          setIngest(p.ingest);
          setAnalysis(p.analysis);
        })
        .catch((e: Error) => setError(e.message)),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useProjectEvents({
    ingest: (event) => {
      if (event.projectId !== id) return;
      setIngest(event.ingest);
      // Before the editor opens, a finished ingest means there is now something to edit.
      if (project && !isReady(project) && (event.ingest.status === 'done' || event.ingest.status === 'error')) void load();
    },
    analysis: (event) => {
      if (event.projectId === id) setAnalysis(event.analysis);
    },
  });

  const rerun = async () => {
    try {
      await rerunIngest(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!project) return;
    if (!window.confirm(`Delete “${project.context.movieTitle || project.source.originalName || id}” and all its files?`)) return;
    await deleteProject(id);
    window.location.hash = projectsHref;
  };

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
  if (!project || !ingest || !analysis) return null;

  if (isReady(project)) {
    return (
      <EditorRoot
        project={project}
        ingest={ingest}
        analysis={analysis}
        onAnalysisChange={setAnalysis}
        onRerunIngest={() => void rerun()}
        onDelete={() => void remove()}
      />
    );
  }

  const { source } = project;
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <a href={projectsHref} className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Projects
      </a>
      <header className="mt-3 flex items-center gap-2">
        <h1 className="truncate text-xl font-semibold tracking-tight">
          {project.context.movieTitle || source.originalName || project.id}
        </h1>
        <StatusBadge ingest={ingest} analysis={analysis} />
      </header>
      <p className="mt-1 text-sm text-neutral-400 tabular-nums">
        {formatTime(source.durationSec)} · {source.width}×{source.height} · {formatFps(source.fps)} fps
      </p>
      <div className="mt-5 grid gap-5 md:grid-cols-[1fr_16rem]">
        <div
          className="flex items-center justify-center rounded-lg bg-black text-sm text-neutral-500"
          style={{ aspectRatio: `${source.width} / ${source.height}` }}
        >
          {ingest.status === 'error' ? 'The clip could not be prepared.' : 'Preparing the clip…'}
        </div>
        <aside className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
          <h2 className="mb-3 text-xs font-medium tracking-wide text-neutral-400 uppercase">Ingest</h2>
          <StageList job={ingest} />
          {ingest.status === 'error' && (
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => void rerun()} className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200">
                Try again
              </button>
              <button type="button" onClick={() => void remove()} className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400">
                Delete
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
