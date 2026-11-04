import { useEffect, useRef } from 'react';
import type { AnalysisEvent, IngestEvent, RenderEvent } from '@als/schema';
import { api } from './api.ts';

export interface ProjectEventHandlers {
  ingest?: (event: IngestEvent) => void;
  analysis?: (event: AnalysisEvent) => void;
  render?: (event: RenderEvent) => void;
  /** The stream came back after a gap; jobs that finished meanwhile sent nothing, so refetch. */
  reconnect?: () => void;
}

/** Calls the handlers for every live ingest, analysis and render update while mounted, and on reconnecting. */
export function useProjectEvents(handlers: ProjectEventHandlers) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(
    () =>
      api.subscribeJobs({
        job: (job) => {
          const h = latest.current;
          if (job.kind === 'ingest') h.ingest?.({ projectId: job.projectId, ingest: job.state });
          else if (job.kind === 'analysis') h.analysis?.({ projectId: job.projectId, analysis: job.state });
          else h.render?.({ projectId: job.projectId, render: job.state });
        },
        reconnect: () => latest.current.reconnect?.(),
      }),
    [],
  );
}
