import type { Analysis } from '@als/schema';
import { sourceFrameToOut } from '@als/composition';
import { useEffect, useState } from 'react';
import { assignSpeaker } from '../../editor/doc.ts';
import { useEditor, useEditorStore, usePlayback } from '../../editor/context.tsx';
import { getAnalysisConfig, getUsage, startAnalysis, type AnalysisConfigInfo } from '../../lib/api.ts';
import { formatUsd } from '../../lib/format.ts';
import { StageList } from '../StageList.tsx';
import { speakerColor } from './speakers.ts';

export interface AnalysisPanelProps {
  analysis: Analysis;
  onStarted: (analysis: Analysis) => void;
}

/** Run or re-run analysis, see what each stage cost, and check the speakers before re-drafting. */
export function AnalysisPanel({ analysis, onStarted }: AnalysisPanelProps) {
  const store = useEditorStore();
  const project = useEditor((s) => s.project);
  const characters = useEditor((s) => s.doc.characters);
  const proposalCost = useEditor((s) => s.proposal?.costUsd);
  const { fps, timeline, seek, player } = usePlayback();
  const [config, setConfig] = useState<AnalysisConfigInfo | null>(null);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof getUsage>> | null>(null);
  const [secondsPerMove, setSecondsPerMove] = useState(analysis.secondsPerMove);
  const [error, setError] = useState<string | null>(null);
  const running = analysis.status === 'pending' || analysis.status === 'running';

  useEffect(() => {
    void getAnalysisConfig().then(setConfig, () => undefined);
  }, []);
  useEffect(() => {
    void getUsage(project.id).then(setUsage, () => undefined);
  }, [project.id, proposalCost, analysis.status]);

  const run = async (rerun?: 'analyst' | 'all') => {
    setError(null);
    if (rerun === 'all' && !window.confirm('Transcribe and describe the clip again, then redraft? This repeats the paid perception calls.')) return;
    try {
      // Drafts are written into the project; save first so nothing in flight is lost.
      await store.getState().flush();
      await startAnalysis(project.id, { ...(rerun ? { rerun } : {}), secondsPerMove });
      onStarted({ ...analysis, status: 'pending', stages: [] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const utterances = project.transcript?.utterances ?? [];
  const labels = [...new Set(utterances.map((u) => u.speaker))];
  const playSample = (label: string) => {
    const first = utterances.find((u) => u.speaker === label);
    if (!first) return;
    seek(sourceFrameToOut(timeline, Math.round(first.start * fps)));
    player.current?.play();
  };

  return (
    <div className="space-y-5 text-sm" data-testid="analysis-panel">
      {config && config.missingKeys.length > 0 && (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/30 p-2.5 text-xs leading-relaxed text-amber-200">
          Analysis needs {config.missingKeys.join(', ')} in <code>apps/server/.env</code>. Add them and restart <code>pnpm dev</code>.
        </div>
      )}
      {config?.replay && (
        <p className="rounded-md border border-sky-900/60 bg-sky-950/30 p-2 text-xs text-sky-200">
          Replaying recorded responses (ANALYSIS_REPLAY_DIR); no APIs are called.
        </p>
      )}

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[11px] font-medium tracking-wide text-neutral-400 uppercase">Last run</h3>
          {analysis.costUsd !== undefined && (
            <span className="text-xs text-neutral-300 tabular-nums" data-testid="analysis-cost">
              {formatUsd(analysis.costUsd)}
            </span>
          )}
        </div>
        {analysis.stages.length ? (
          <StageList job={analysis} details />
        ) : (
          <p className="text-xs text-neutral-500">{running ? 'Starting…' : 'Not analysed yet.'}</p>
        )}
        {analysis.error && !analysis.stages.some((s) => s.error) && <p className="mt-2 text-xs text-red-300">{analysis.error}</p>}
        {usage &&
          (
            [
              ['regenerate', 'Regenerate'],
              ['evaluate', 'Re-evaluate bar'],
              ['regions', 'Card placement'],
            ] as const
          ).map(([kind, label]) =>
            usage[kind].count > 0 ? (
              <p key={kind} className="mt-2 text-xs text-neutral-500 tabular-nums">
                {label}: {usage[kind].count} call{usage[kind].count === 1 ? '' : 's'} · {formatUsd(usage[kind].costUsd)}
              </p>
            ) : null,
          )}
      </section>

      <section className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          About one move every
          <input
            type="number"
            min={5}
            max={120}
            step={5}
            value={secondsPerMove}
            onChange={(e) => setSecondsPerMove(Number(e.target.value) || analysis.secondsPerMove)}
            className="input w-16 py-1 text-center tabular-nums"
          />
          seconds
        </label>
        {analysis.status === 'idle' ? (
          <button type="button" disabled={running} onClick={() => void run()} className="w-full rounded-md bg-sky-500 py-1.5 text-xs font-medium text-neutral-950 hover:bg-sky-400 disabled:opacity-40">
            Analyse clip
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={running}
              onClick={() => void run('analyst')}
              title="Redraft with the saved transcript and scene notes (Stages 1 and 2 are not repeated)"
              className="flex-1 rounded-md bg-sky-500 py-1.5 text-xs font-medium text-neutral-950 hover:bg-sky-400 disabled:opacity-40"
            >
              Re-run Analyst
            </button>
            <button
              type="button"
              disabled={running}
              onClick={() => void run('all')}
              className="rounded-md border border-neutral-700 px-2 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
            >
              Redo all
            </button>
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-neutral-500">
          Re-running replaces AI drafts. Moves you approved or added yourself are kept, and History has the version before.
        </p>
        {error && <p className="text-xs text-red-300">{error}</p>}
      </section>

      {labels.length > 0 && (
        <section data-testid="speaker-check">
          <h3 className="mb-1 text-[11px] font-medium tracking-wide text-neutral-400 uppercase">Check the speakers</h3>
          <p className="mb-2 text-[11px] text-neutral-500">Fix a wrong name, then Re-run Analyst so the drafts use it.</p>
          <ul className="space-y-1.5">
            {labels.map((label) => (
              <li key={label} className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => playSample(label)}
                  title="Play their first line"
                  className="flex size-6 shrink-0 items-center justify-center rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500"
                >
                  ▶
                </button>
                <span className="w-16 shrink-0 font-medium" style={{ color: speakerColor(labels, label) }}>
                  Speaker {label}
                </span>
                <select
                  value={characters.find((c) => c.speakerLabels.includes(label))?.id ?? ''}
                  aria-label={`Speaker ${label} is`}
                  onChange={(e) => store.getState().edit((d) => assignSpeaker(d, label, e.target.value || null))}
                  className="input flex-1 py-1 text-xs"
                >
                  <option value="">Unassigned</option>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || 'Unnamed'}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}

      {config && (
        <p className="text-[11px] leading-relaxed text-neutral-600">
          Models: {config.models.transcriber} · {config.models.scene} · {config.models.naming} · {config.models.analyst} (Regenerate:{' '}
          {config.models.regen})
        </p>
      )}
    </div>
  );
}
