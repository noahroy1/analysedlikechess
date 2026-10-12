import type { Analysis, Ingest, Stage } from '@als/schema';
import { formatMs, formatUsd } from '../lib/format.ts';

const LABELS: Record<string, string> = {
  hash: 'Fingerprint source',
  probe: 'Read video info',
  proxy: 'Make playback proxy',
  audio: 'Extract audio',
  shots: 'Detect cuts',
  thumbnails: 'Shot thumbnails',
  transcribe: 'Transcribe dialogue',
  describe: 'Describe the scene',
  speakers: 'Name the speakers',
  decisions: 'Find decision points',
  annotate: 'Rate and write moves',
  snap: 'Place on frames',
  place: 'Place cards clear of faces',
};

const STATUS_STYLE: Record<Stage['status'], string> = {
  pending: 'text-neutral-500',
  running: 'text-sky-300',
  done: 'text-emerald-400',
  cached: 'text-neutral-400',
  skipped: 'text-neutral-500',
  error: 'text-red-400',
};

const STATUS_TEXT: Record<Stage['status'], string> = {
  pending: 'Waiting',
  running: 'Running',
  done: 'Done',
  cached: 'Unchanged',
  skipped: 'Skipped',
  error: 'Failed',
};

/** Overall 0-1 progress, counting finished stages as whole and the running one by its fraction. */
export function jobProgress(job: { stages: Stage[] }): number {
  if (!job.stages.length) return 0;
  const finished = job.stages.filter((s) => ['done', 'cached', 'skipped'].includes(s.status)).length;
  const running = job.stages.filter((s) => s.status === 'running').reduce((sum, s) => sum + (s.progress ?? 0), 0);
  return (finished + running) / job.stages.length;
}

/** A job's stages; with `details`, the model, tokens and cost of each. */
export function StageList({ job, details = false }: { job: { stages: Stage[] }; details?: boolean }) {
  return (
    <ol className="space-y-2.5">
      {job.stages.map((stage) => (
        <li key={stage.name} className="text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className={stage.status === 'pending' ? 'text-neutral-500' : 'text-neutral-200'}>
              {LABELS[stage.name] ?? stage.name}
            </span>
            <span className={`shrink-0 text-xs tabular-nums ${STATUS_STYLE[stage.status]}`}>
              {stage.status === 'running' && stage.progress !== undefined
                ? `${Math.round(stage.progress * 100)}%`
                : STATUS_TEXT[stage.status]}
              {stage.status === 'done' && stage.durationMs !== undefined && (
                <span className="text-neutral-500"> · {formatMs(stage.durationMs)}</span>
              )}
            </span>
          </div>
          {stage.status === 'running' && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-sky-400 transition-[width] duration-150"
                style={{ width: `${(stage.progress ?? 0) * 100}%` }}
              />
            </div>
          )}
          {details && stage.status === 'done' && (stage.model || stage.costUsd !== undefined) && (
            <div className="mt-0.5 flex justify-between gap-2 text-[11px] text-neutral-500 tabular-nums" data-testid={`stage-cost-${stage.name}`}>
              <span className="truncate">{stage.model?.replace(/^[a-z]+\//, '')}</span>
              <span className="shrink-0">
                {usageText(stage)}
                {stage.costUsd !== undefined && ` · ${formatUsd(stage.costUsd)}`}
              </span>
            </div>
          )}
          {stage.error && <pre className="mt-1.5 whitespace-pre-wrap text-xs text-red-300">{stage.error}</pre>}
        </li>
      ))}
    </ol>
  );
}

function usageText(stage: Stage): string {
  const u = stage.usage;
  if (!u) return '';
  if (u.audioSec !== undefined) return `${Math.round(u.audioSec)} s audio`;
  const input = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  return `${compact(input)} in / ${compact(u.outputTokens ?? 0)} out`;
}

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const BADGE = {
  queued: 'bg-neutral-800 text-neutral-300',
  working: 'bg-sky-950 text-sky-300',
  ready: 'bg-emerald-950 text-emerald-300',
  failed: 'bg-red-950 text-red-300',
} as const;

/** Where a project stands: ingest first, then analysis. */
export function StatusBadge({ ingest, analysis }: { ingest: Ingest; analysis?: Analysis }) {
  let tone: keyof typeof BADGE;
  let text: string;
  if (ingest.status !== 'done') {
    tone = ingest.status === 'error' ? 'failed' : ingest.status === 'pending' ? 'queued' : 'working';
    text = { pending: 'Queued', running: `Processing ${Math.round(jobProgress(ingest) * 100)}%`, error: 'Failed' }[ingest.status];
  } else if (analysis?.status === 'pending' || analysis?.status === 'running') {
    tone = 'working';
    text = `Drafting moves ${Math.round(jobProgress(analysis) * 100)}%`;
  } else if (analysis?.status === 'error') {
    tone = 'failed';
    text = 'Analysis failed';
  } else {
    tone = 'ready';
    text = analysis?.status === 'done' ? 'Drafts ready' : 'Ready';
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${BADGE[tone]}`} data-testid="status-badge">
      {text}
    </span>
  );
}
