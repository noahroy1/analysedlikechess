import { useEffect, useRef } from 'react';
import { subscribeProjectEvents, type ProjectEventHandlers } from './api.ts';

/** Calls the handlers for every live ingest, analysis and render update while mounted, and on reconnecting. */
export function useProjectEvents(handlers: ProjectEventHandlers) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(
    () =>
      subscribeProjectEvents({
        ingest: (e) => latest.current.ingest?.(e),
        analysis: (e) => latest.current.analysis?.(e),
        render: (e) => latest.current.render?.(e),
        reconnect: () => latest.current.reconnect?.(),
      }),
    [],
  );
}
