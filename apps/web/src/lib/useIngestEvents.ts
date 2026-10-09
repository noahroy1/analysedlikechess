import type { IngestEvent } from '@als/schema';
import { useEffect, useRef } from 'react';
import { subscribeIngest } from './api.ts';

/** Calls `onEvent` for every live ingest update while the component is mounted. */
export function useIngestEvents(onEvent: (event: IngestEvent) => void) {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => subscribeIngest((event) => handler.current(event)), []);
}
