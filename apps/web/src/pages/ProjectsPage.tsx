import type { ProjectSummary } from '@als/schema';
import { useEffect, useState } from 'react';
import { StatusBadge } from '../components/StageList.tsx';
import { UploadPanel } from '../components/UploadPanel.tsx';
import { fileUrl, listProjects } from '../lib/api.ts';
import { formatDate, formatFps, formatTime } from '../lib/format.ts';
import { projectHref } from '../lib/router.ts';
import { useProjectEvents } from '../lib/useProjectEvents.ts';

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    listProjects()
      .then(setProjects)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  useProjectEvents({
    ingest: (event) => {
      // Finished jobs change the poster and shot count, so refetch; otherwise patch progress in place.
      if (event.ingest.status === 'done' || event.ingest.status === 'error') void load();
      else setProjects((list) => list?.map((p) => (p.id === event.projectId ? { ...p, ingest: event.ingest } : p)) ?? null);
    },
    analysis: (event) => {
      if (event.analysis.status === 'done' || event.analysis.status === 'error') void load();
      else setProjects((list) => list?.map((p) => (p.id === event.projectId ? { ...p, analysis: event.analysis } : p)) ?? null);
    },
    reconnect: () => void load(),
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Analysed Like Chess Studio</h1>
        <p className="mt-1 text-sm text-neutral-400">Upload a scene, review the moves, render the episode.</p>
      </header>

      <UploadPanel />

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium text-neutral-300">Projects</h2>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {projects?.length === 0 && <p className="text-sm text-neutral-500">No projects yet.</p>}
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects?.map((p) => (
            <li key={p.id}>
              <a
                href={projectHref(p.id)}
                className="group block overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60 transition-colors hover:border-neutral-600"
              >
                <div className="aspect-video bg-neutral-950">
                  {p.poster && (
                    <img src={fileUrl(p.id, p.poster, p.version)} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate text-sm font-medium text-neutral-100">{p.name}</h3>
                    <StatusBadge ingest={p.ingest} analysis={p.analysis} />
                  </div>
                  <p className="mt-1 text-xs text-neutral-500 tabular-nums">
                    {formatTime(p.source.durationSec, 0)} · {p.source.height}p{formatFps(p.source.fps)}
                    {p.shotCount > 0 && ` · ${p.shotCount} shots`}
                    {p.momentCount > 0 && ` · ${p.momentCount} moves`}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-600">{formatDate(p.createdAt)}</p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
