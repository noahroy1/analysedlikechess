import type { Analysis, Ingest, Stage } from '@als/schema';

const STAGE_LABELS: Record<string, string> = {
  hash: 'Reading the clip',
  probe: 'Reading the clip',
  proxy: 'Preparing playback',
  audio: 'Extracting audio',
  shots: 'Finding cuts',
  thumbnails: 'Making thumbnails',
  transcribe: 'Transcribing',
  describe: 'Watching the scene',
  speakers: 'Naming speakers',
  decisions: 'Finding the moves',
  annotate: 'Writing the cards',
  snap: 'Timing the cards',
  place: 'Placing the cards',
  evaluate: 'Scoring the bar',
};

const active = (job: { status: string }) => job.status === 'pending' || job.status === 'running';

/** 0-1: finished stages count whole, the running one by its fraction. */
export function jobProgress(job: { stages: Stage[] }): number {
  if (!job.stages.length) return 0;
  const finished = job.stages.filter((s) => ['done', 'cached', 'skipped'].includes(s.status)).length;
  const running = job.stages.filter((s) => s.status === 'running').reduce((sum, s) => sum + (s.progress ?? 0), 0);
  return (finished + running) / job.stages.length;
}

/** One line for where a project is: preparing, drafting, failed or ready. */
export function projectStatus(ingest: Ingest, analysis: Analysis): { text: string; tone: 'busy' | 'error' | 'ready'; progress?: number } {
  if (ingest.status === 'error') return { text: 'The clip could not be prepared', tone: 'error' };
  if (active(ingest)) {
    const stage = ingest.stages.find((s) => s.status === 'running');
    return { text: stage ? (STAGE_LABELS[stage.name] ?? 'Preparing') : 'Preparing', tone: 'busy', progress: jobProgress(ingest) };
  }
  if (active(analysis)) {
    const stage = analysis.stages.find((s) => s.status === 'running');
    return { text: `Drafting · ${stage ? (STAGE_LABELS[stage.name] ?? stage.name) : 'waiting'}`, tone: 'busy', progress: jobProgress(analysis) };
  }
  if (analysis.status === 'error') return { text: 'Drafting failed', tone: 'error' };
  return { text: 'Ready', tone: 'ready' };
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-neutral-800">
      <div className="h-full bg-sky-400 transition-[width]" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}
