import { RENDER_PRESETS, presetSize, type RenderJob, type RenderPreset } from '@als/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, useEditorStore } from '../../editor/context.tsx';
import { cancelRender, deleteRender, fileUrl, listRenders, revealRender, startRender } from '../../lib/api.ts';
import { formatDate, formatTime } from '../../lib/format.ts';
import { useProjectEvents } from '../../lib/useProjectEvents.ts';
import { HeaderButton } from './HeaderButton.tsx';

const PRESET_LABEL: Record<RenderPreset, string> = { source: 'Source', '1080p': '1080p', '2160p': '4K' };

const active = (job: RenderJob) => job.status === 'pending' || job.status === 'running';

const formatSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`);

/**
 * Render to MP4: saves first, then renders the saved version, so what renders
 * is exactly what the editor shows. Lists earlier renders with their files.
 */
export function RenderMenu() {
  const store = useEditorStore();
  const project = useEditor((s) => s.project);
  const saveStatus = useEditor((s) => s.saveStatus);
  const [open, setOpen] = useState(false);
  const [renders, setRenders] = useState<RenderJob[]>([]);
  const [preset, setPreset] = useState<RenderPreset | null>(null);
  const [starting, setStarting] = useState(false);
  const { id, source } = project;

  const refresh = useCallback(() => listRenders(id).then(setRenders, () => undefined), [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live progress; a render that ends is announced even with the menu closed.
  const announced = useRef(new Set<string>());
  useProjectEvents({
    render: ({ projectId, render }) => {
      if (projectId !== id) return;
      setRenders((list) => (list.some((r) => r.id === render.id) ? list.map((r) => (r.id === render.id ? render : r)) : [render, ...list]));
      if (!active(render) && !announced.current.has(render.id)) {
        announced.current.add(render.id);
        if (render.status === 'done') store.getState().notify(`Render finished: ${render.width}×${render.height}, ${formatSize(render.sizeBytes ?? 0)}.`);
        if (render.status === 'failed') store.getState().notify(`Render failed: ${render.error ?? 'unknown error'}`, 'error');
      }
    },
    // A render that ended while the stream was down sent its last update to no one.
    reconnect: () => void refresh(),
  });

  const presets = RENDER_PRESETS.flatMap((p) => {
    const size = presetSize(source, p);
    // A preset the source already is would only repeat "Source".
    return size && (p === 'source' || size.height !== source.height) ? [{ preset: p, ...size }] : [];
  });
  const chosen = preset ?? renders.find((r) => presets.some((p) => p.preset === r.preset))?.preset ?? 'source';
  const running = renders.find(active);

  const start = async () => {
    setStarting(true);
    try {
      // Render what is saved: save pending edits first, and retry once if a save lands meanwhile.
      for (let attempt = 0; attempt < 2; attempt++) {
        await store.getState().flush();
        const { saveStatus: status, baseVersion } = store.getState();
        if (status === 'invalid' || status === 'error') {
          store.getState().notify('Fix what stops the project saving before rendering.', 'error');
          return;
        }
        const result = await startRender(id, { version: baseVersion, preset: chosen });
        if (result.kind === 'started') {
          setRenders((list) => [result.render, ...list.filter((r) => r.id !== result.render.id)]);
          return;
        }
      }
      store.getState().notify('The project kept changing; try Render again.', 'warn');
    } catch (error) {
      store.getState().notify((error as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  };

  const act = (action: () => Promise<unknown>) => () => {
    action().then(refresh, (error: Error) => store.getState().notify(error.message, 'error'));
  };

  const label = running ? `Rendering ${Math.round(running.progress * 100)}%` : 'Render';

  return (
    <div className="relative">
      <HeaderButton onClick={() => setOpen((o) => !o)} title="Render the episode to MP4" primary>
        {label}
      </HeaderButton>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-80 rounded-md border border-neutral-700 bg-neutral-950 p-3 shadow-xl" data-testid="render-menu">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-neutral-400">
              Size
              <select
                value={chosen}
                onChange={(e) => setPreset(e.target.value as RenderPreset)}
                data-testid="render-preset"
                className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
              >
                {presets.map((p) => (
                  <option key={p.preset} value={p.preset}>
                    {PRESET_LABEL[p.preset]} · {p.width}×{p.height}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void start()}
              disabled={Boolean(running) || starting}
              data-testid="render-start"
              className="ml-auto rounded-md border border-sky-700 bg-sky-900/50 px-3 py-1 text-xs font-medium text-sky-100 hover:border-sky-500 disabled:opacity-40"
            >
              {starting ? 'Saving…' : 'Render MP4'}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-neutral-500">
            H.264 and AAC from the original clip, {source.width}×{source.height} at the source frame rate.
            {saveStatus !== 'saved' && ' Unsaved edits are saved first.'}
          </p>

          <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto" data-testid="render-list">
            {renders.length === 0 && <li className="text-xs text-neutral-500">No renders yet.</li>}
            {renders.map((r) => (
              <RenderRow key={r.id} job={r} projectId={id} act={act} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RenderRow({ job, projectId, act }: { job: RenderJob; projectId: string; act: (action: () => Promise<unknown>) => () => void }) {
  const lengthSec = job.frames / job.fps;
  return (
    <li className="rounded-md border border-neutral-800 px-2.5 py-2 text-xs" data-testid="render-row" data-status={job.status}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-neutral-200 tabular-nums">
          v{job.projectVersion} · {job.width}×{job.height}
        </span>
        <span className="text-neutral-500">{formatDate(job.createdAt)}</span>
      </div>
      {active(job) ? (
        <div className="mt-1.5">
          <div className="flex justify-between text-neutral-400">
            <span>{job.stage ?? 'Queued'}</span>
            <span className="tabular-nums">{Math.round(job.progress * 100)}%</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded bg-neutral-800">
            <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${job.progress * 100}%` }} />
          </div>
          <button type="button" onClick={act(() => cancelRender(projectId, job.id))} className="mt-1.5 text-neutral-400 hover:text-red-300">
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-3">
          {job.status === 'done' ? (
            <>
              <span className="text-neutral-500 tabular-nums">
                {formatTime(lengthSec, 0)} · {formatSize(job.sizeBytes ?? 0)}
              </span>
              <a href={fileUrl(projectId, job.file)} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                Play
              </a>
              <button type="button" onClick={act(() => revealRender(projectId, job.id))} className="text-sky-400 hover:underline">
                Show in Finder
              </button>
            </>
          ) : (
            <span className={job.status === 'failed' ? 'text-red-400' : 'text-neutral-500'} title={job.error}>
              {job.status === 'failed' ? `Failed: ${job.error ?? ''}`.slice(0, 80) : 'Cancelled'}
            </span>
          )}
          <button type="button" onClick={act(() => deleteRender(projectId, job.id))} className="ml-auto text-neutral-500 hover:text-red-300">
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
