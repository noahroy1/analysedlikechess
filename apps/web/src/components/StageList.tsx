import type { Ingest, Stage } from '@als/schema';
import { formatMs } from '../lib/format.ts';

const LABELS: Record<string, string> = {
  hash: 'Fingerprint source',
  probe: 'Read video info',
  proxy: 'Make playback proxy',
  audio: 'Extract audio',
  shots: 'Detect cuts',
  thumbnails: 'Shot thumbnails',
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
export function ingestProgress(ingest: Ingest): number {
  const finished = ingest.stages.filter((s) => ['done', 'cached', 'skipped'].includes(s.status)).length;
  const running = ingest.stages.find((s) => s.status === 'running');
  return (finished + (running?.progress ?? 0)) / ingest.stages.length;
}

export function StageList({ ingest }: { ingest: Ingest }) {
  return (
    <ol className="space-y-2.5">
      {ingest.stages.map((stage) => (
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
          {stage.error && <pre className="mt-1.5 whitespace-pre-wrap text-xs text-red-300">{stage.error}</pre>}
        </li>
      ))}
    </ol>
  );
}

export function StatusBadge({ ingest }: { ingest: Ingest }) {
  const styles = {
    pending: 'bg-neutral-800 text-neutral-300',
    running: 'bg-sky-950 text-sky-300',
    done: 'bg-emerald-950 text-emerald-300',
    error: 'bg-red-950 text-red-300',
  } as const;
  const text = {
    pending: 'Queued',
    running: `Processing ${Math.round(ingestProgress(ingest) * 100)}%`,
    done: 'Ready',
    error: 'Failed',
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${styles[ingest.status]}`}>
      {text[ingest.status]}
    </span>
  );
}
