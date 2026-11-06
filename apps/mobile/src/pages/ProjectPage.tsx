import { projectName, type Analysis, type Ingest, type Project } from '@als/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Editor } from '../components/Editor.tsx';
import { ProgressBar, projectStatus } from '../components/status.tsx';
import { api } from '../lib/api.ts';
import { projectsHref } from '../lib/router.ts';
import { useJobs } from '../lib/useJobs.ts';

const isReady = (project: Project) =>
  project.ingest.status === 'done' && project.ingest.stages.some((s) => s.name === 'proxy' && (s.status === 'done' || s.status === 'cached'));

/** Progress while the clip is prepared, then the editor. */
export function ProjectPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [ingest, setIngest] = useState<Ingest | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaUntil, setMediaUntil] = useState<string | undefined>();
  /**
   * Counts analyses seen to finish. The editor reloads its drafts when it changes. A count rather than a
   * status change: a fast analysis can finish while a load is in flight, and that load's older status
   * would otherwise hide the end from the editor (seen with replayed answers in the simulator).
   */
  const [analysisEnded, setAnalysisEnded] = useState(0);
  const ended = useRef(0);
  const markEnded = useCallback(() => setAnalysisEnded(++ended.current), []);
  // (The editor holds its own copy of the project once open, and reloads it when this count moves.)

  // Only the latest load applies: an older one still in flight may predate an analysis's drafts.
  const loads = useRef(0);
  const load = useCallback(() => {
    const n = ++loads.current;
    return Promise.all([api.getProject(id), api.loadMedia(id)])
      .then(([p]) => {
        if (n !== loads.current) return;
        setMediaUntil(api.mediaExpiresAt(id));
        setProject(p);
        setIngest(p.ingest);
        setAnalysis(p.analysis);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Signed media URLs last 6 h: new ones an hour before, which gives the Player new sources.
  useEffect(() => {
    if (!mediaUntil) return;
    const refreshIn = Math.max(60_000, Date.parse(mediaUntil) - Date.now() - 60 * 60 * 1000);
    const timer = setTimeout(() => void api.loadMedia(id).then(() => setMediaUntil(api.mediaExpiresAt(id)), () => undefined), refreshIn);
    return () => clearTimeout(timer);
  }, [id, mediaUntil]);

  useJobs({
    job: (job) => {
      if (job.projectId !== id) return;
      if (job.kind === 'ingest') {
        setIngest(job.state);
        if (project && !isReady(project) && (job.state.status === 'done' || job.state.status === 'error')) void load();
      } else if (job.kind === 'analysis') {
        setAnalysis(job.state);
        if (job.state.status === 'done' || job.state.status === 'error') {
          markEnded();
          // Before the editor opens, the page's own copy needs the drafts too.
          if (project && !isReady(project)) void load();
        }
      }
    },
    // Back from a gap (the app was in the background): jobs that ended meanwhile sent nothing.
    reconnect: () => {
      if (project && !isReady(project)) return void load();
      const was = analysis?.status;
      void api.getProject(id).then((p) => {
        setIngest(p.ingest);
        setAnalysis(p.analysis);
        const nowEnded = p.analysis.status === 'done' || p.analysis.status === 'error';
        if (nowEnded && (was === 'pending' || was === 'running')) markEnded();
      }, () => undefined);
    },
  });

  const back = (
    <a href={projectsHref} className="btn-quiet px-1">
      ‹ Projects
    </a>
  );

  if (error) {
    return (
      <div className="px-4 pt-3">
        {back}
        <p className="mt-6 text-sm text-red-400">{error}</p>
      </div>
    );
  }
  if (!project || !ingest || !analysis) return <div className="px-4 pt-3">{back}</div>;
  if (isReady(project)) return <Editor project={project} analysis={analysis} analysisEnded={analysisEnded} mediaUntil={mediaUntil} />;

  const status = projectStatus(ingest, analysis);
  return (
    <div className="px-4 pt-3">
      {back}
      <h1 className="mt-3 truncate text-lg font-semibold">{projectName(project)}</h1>
      <div className="mt-4 flex items-center justify-center rounded-xl bg-neutral-900 text-sm text-neutral-500" style={{ aspectRatio: `${project.source.width} / ${project.source.height}`, maxHeight: '50vh' }}>
        {status.text}…
      </div>
      {status.progress !== undefined && (
        <div className="mt-3">
          <ProgressBar value={status.progress} />
        </div>
      )}
      {ingest.status === 'error' && (
        <button type="button" className="btn mt-4" onClick={() => void api.rerunIngest(id).catch((e: Error) => setError(e.message))}>
          Try again
        </button>
      )}
    </div>
  );
}
