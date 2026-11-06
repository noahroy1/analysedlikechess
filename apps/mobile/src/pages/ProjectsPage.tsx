import type { ProjectSummary } from '@als/schema';
import { useEffect, useRef, useState } from 'react';
import { ProgressBar, projectStatus } from '../components/status.tsx';
import { api } from '../lib/api.ts';
import { formatDate, formatTime } from '../lib/format.ts';
import { projectHref } from '../lib/router.ts';
import { session } from '../lib/session.ts';
import { upload, useUpload } from '../lib/upload.ts';
import { useJobs } from '../lib/useJobs.ts';

/** The user's projects, newest first, and a new upload from the camera roll. */
export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const current = useUpload();

  const load = () =>
    api
      .listProjects()
      .then((list) => {
        setProjects(list);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  // A finished upload opens its project.
  useEffect(() => {
    if (current?.status === 'done' && current.projectId) {
      const id = current.projectId;
      upload.clear();
      window.location.hash = projectHref(id);
    }
  }, [current]);

  useJobs({
    job: (job) => {
      if (job.kind === 'render') return;
      const ended = job.state.status === 'done' || job.state.status === 'error';
      if (ended) return void load();
      setProjects((list) => list?.map((p) => (p.id !== job.projectId ? p : job.kind === 'ingest' ? { ...p, ingest: job.state } : { ...p, analysis: job.state })) ?? null);
    },
    reconnect: () => void load(),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-4 pt-3 pb-2">
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
        <div className="flex items-center gap-1">
          <button type="button" className="btn-quiet px-2" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="btn-quiet px-2" onClick={() => void session.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-28">
        {current && <UploadCard />}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        {projects?.length === 0 && !current && <p className="mt-10 text-center text-sm text-neutral-500">No projects yet. Add a scene from your camera roll.</p>}
        <ul className="mt-2 flex flex-col gap-3">
          {projects?.map((p) => {
            const status = projectStatus(p.ingest, p.analysis);
            return (
              <li key={p.id}>
                <a href={projectHref(p.id)} className="flex gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2 active:bg-neutral-800">
                  <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-neutral-950">
                    {p.poster && <img src={api.fileUrl(p.id, p.poster, p.version)} alt="" className="h-full w-full object-cover" />}
                  </div>
                  <div className="min-w-0 flex-1 py-0.5">
                    <h2 className="truncate text-sm font-medium">{p.name}</h2>
                    <p className="mt-0.5 text-xs text-neutral-500 tabular-nums">
                      {formatTime(p.source.durationSec)} · {p.momentCount} move{p.momentCount === 1 ? '' : 's'} · {formatDate(p.createdAt)}
                    </p>
                    <p className={`mt-1.5 text-xs ${status.tone === 'error' ? 'text-red-400' : status.tone === 'busy' ? 'text-sky-300' : 'text-neutral-400'}`}>{status.text}</p>
                    {status.progress !== undefined && (
                      <div className="mt-1">
                        <ProgressBar value={status.progress} />
                      </div>
                    )}
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-neutral-800 bg-neutral-950/95 px-4 pt-3">
        <button type="button" className="btn-primary w-full" disabled={Boolean(current && current.status !== 'failed')} onClick={() => setAdding(true)}>
          New scene from camera roll
        </button>
      </div>
      {adding && <NewSceneSheet onClose={() => setAdding(false)} />}
    </div>
  );
}

function UploadCard() {
  const current = useUpload();
  if (!current) return null;
  const pct = Math.round(current.progress * 100);
  const text =
    current.status === 'failed'
      ? `Upload stopped at ${pct}%: ${current.error ?? 'error'}`
      : current.status === 'paused'
        ? `Paused at ${pct}%: continues when the app is open`
        : current.progress < 1
          ? `Uploading ${pct}%`
          : 'Reading the video…';
  return (
    <div className="mt-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3" data-testid="upload-card">
      <p className="truncate text-sm font-medium">{current.fileName}</p>
      <p className={`mt-1 text-xs ${current.status === 'failed' ? 'text-red-400' : 'text-neutral-400'}`}>{text}</p>
      <div className="mt-2">
        <ProgressBar value={current.progress} />
      </div>
      <div className="mt-2 flex gap-2">
        {current.status === 'failed' && (
          <button type="button" className="btn px-3 py-1.5 text-xs" onClick={upload.retry}>
            Try again
          </button>
        )}
        <button type="button" className="btn-quiet text-xs" onClick={upload.cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What the analysis is told about the scene (all optional), then the camera roll. */
function NewSceneSheet({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [movieTitle, setMovieTitle] = useState('');
  const [characters, setCharacters] = useState('');

  const pick = (file: File | undefined) => {
    if (!file) return;
    upload.start(file, {
      ...(movieTitle.trim() ? { movieTitle: movieTitle.trim() } : {}),
      characters: [...new Set(characters.split(',').map((n) => n.trim()).filter(Boolean))],
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div className="safe-bottom rounded-t-2xl border-t border-neutral-800 bg-neutral-950 px-4 pt-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">New scene</h2>
        <label className="mt-3 block text-xs text-neutral-400">
          Movie or show (optional)
          <input value={movieTitle} onChange={(e) => setMovieTitle(e.target.value)} placeholder="Breaking Bad" className="field mt-1" />
        </label>
        <label className="mt-3 block text-xs text-neutral-400">
          Characters (optional, comma-separated)
          <input value={characters} onChange={(e) => setCharacters(e.target.value)} placeholder="Walt, Hank" className="field mt-1" />
        </label>
        <button type="button" className="btn-primary mt-4 w-full" onClick={() => input.current?.click()}>
          Choose a video
        </button>
        <button type="button" className="btn-quiet mt-1 w-full" onClick={onClose}>
          Cancel
        </button>
        {/* The photo library, the camera or Files: iOS's own picker. */}
        <input ref={input} type="file" accept="video/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} data-testid="file-input" />
      </div>
    </div>
  );
}
