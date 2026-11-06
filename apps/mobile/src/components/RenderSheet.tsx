import { RENDER_PRESETS, presetSize, projectName, type RenderJob, type RenderPreset } from '@als/schema';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { formatDate, formatSize } from '../lib/format.ts';
import { shareRender } from '../lib/share.ts';
import { useJobs } from '../lib/useJobs.ts';
import { useEditor, useEditorStore } from './Editor.tsx';
import { ProgressBar } from './status.tsx';

const PRESET_LABEL: Record<RenderPreset, string> = { source: 'Source', '1080p': '1080p', '2160p': '4K' };
const active = (job: RenderJob) => job.status === 'pending' || job.status === 'running';

/** Render the saved version to MP4 in the cloud, follow it live, and share the file. */
export function RenderSheet({ onClose }: { onClose: () => void }) {
  const store = useEditorStore();
  const project = useEditor((s) => s.project);
  const title = useEditor((s) => s.doc.title);
  const [renders, setRenders] = useState<RenderJob[]>([]);
  const [preset, setPreset] = useState<RenderPreset>('source');
  const [starting, setStarting] = useState(false);
  const [sharing, setSharing] = useState<{ id: string; progress: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { id, source } = project;

  const refresh = useCallback(() => api.listRenders(id).then(setRenders, () => undefined), [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useJobs({
    job: (job) => {
      if (job.kind !== 'render' || job.projectId !== id) return;
      const render = job.state;
      setRenders((list) => (list.some((r) => r.id === render.id) ? list.map((r) => (r.id === render.id ? render : r)) : [render, ...list]));
    },
    reconnect: () => void refresh(),
  });

  // The desktop's sizes; 4K is left to the desktop (a phone has no use for the file size).
  const presets = RENDER_PRESETS.filter((p) => p !== '2160p').flatMap((p) => {
    const size = presetSize(source, p);
    return size && (p === 'source' || size.height !== source.height) ? [{ preset: p, ...size }] : [];
  });
  const running = renders.find(active);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      // Render what is saved: save first, and once more if a save lands meanwhile.
      for (let attempt = 0; attempt < 2; attempt++) {
        await store.getState().flush();
        const { saveStatus, baseVersion } = store.getState();
        if (saveStatus === 'invalid' || saveStatus === 'error') throw new Error('Fix what stops the project saving before rendering.');
        const result = await api.startRender(id, { version: baseVersion, preset });
        if (result.kind === 'started') {
          setRenders((list) => [result.render, ...list.filter((r) => r.id !== result.render.id)]);
          return;
        }
      }
      throw new Error('The project kept changing; try Render again.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const share = async (render: RenderJob) => {
    setSharing({ id: render.id, progress: 0 });
    setError(null);
    try {
      await shareRender(id, render.id, projectName({ ...project, ...(title ? { title } : {}) }), (progress) => setSharing({ id: render.id, progress }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSharing(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div className="max-h-[75dvh] overflow-y-auto rounded-t-2xl border-t border-neutral-700 bg-neutral-950 px-4 pt-3 safe-bottom" onClick={(e) => e.stopPropagation()} data-testid="render-sheet">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Render MP4</h2>
          <button type="button" className="btn-quiet px-2" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mt-3 flex gap-2">
          {presets.map((p) => (
            <button key={p.preset} type="button" onClick={() => setPreset(p.preset)} className={`flex-1 rounded-lg border px-2 py-2 text-xs ${preset === p.preset ? 'border-sky-600 bg-sky-950/40 text-sky-100' : 'border-neutral-700 text-neutral-300'}`}>
              {PRESET_LABEL[p.preset]}
              <span className="block text-[10px] text-neutral-500">
                {p.width}×{p.height}
              </span>
            </button>
          ))}
        </div>
        <button type="button" className="btn-primary mt-3 w-full" disabled={Boolean(running) || starting} onClick={() => void start()} data-testid="render-start">
          {starting ? 'Saving…' : running ? 'Rendering…' : 'Render'}
        </button>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        <ul className="mt-4 flex flex-col gap-2 pb-2">
          {renders.map((r) => (
            <li key={r.id} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-2.5 text-xs" data-testid="render-row">
              <div className="flex items-center justify-between gap-2">
                <span className="text-neutral-300 tabular-nums">
                  {r.width}×{r.height} · {formatDate(r.createdAt)}
                  {r.sizeBytes ? ` · ${formatSize(r.sizeBytes)}` : ''}
                </span>
                {r.status === 'done' && (
                  <button type="button" className="btn px-3 py-1 text-xs" disabled={Boolean(sharing)} onClick={() => void share(r)} data-testid="render-share">
                    {sharing?.id === r.id ? `Preparing ${Math.round(sharing.progress * 100)}%` : 'Share'}
                  </button>
                )}
                {active(r) && (
                  <button type="button" className="btn-quiet text-xs" onClick={() => void api.cancelRender(id, r.id).then(refresh, (e: Error) => setError(e.message))}>
                    Cancel
                  </button>
                )}
              </div>
              {active(r) && (
                <div className="mt-2">
                  <p className="mb-1 text-neutral-500">{r.stage ?? 'Waiting'} · {Math.round(r.progress * 100)}%</p>
                  <ProgressBar value={r.progress} />
                </div>
              )}
              {r.status === 'failed' && <p className="mt-1 text-red-400">{r.error ?? 'Failed'}</p>}
              {r.status === 'cancelled' && <p className="mt-1 text-neutral-500">Cancelled</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
