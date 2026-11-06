import type { Job } from '@als/schema';
import { useEffect, useRef } from 'react';
import { api } from './api.ts';

/** Calls `job` for every live job update while mounted (and every running job on each reconnect), `reconnect` after a gap. */
export function useJobs(handlers: { job: (job: Job) => void; reconnect?: () => void }) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => api.subscribeJobs({ job: (job) => latest.current.job(job), reconnect: () => latest.current.reconnect?.() }), []);
}
