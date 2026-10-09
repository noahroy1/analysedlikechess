import type { Ingest } from '@als/schema';
import { JobQueue, stageSignature } from '../jobs.ts';
import type { ProjectStore } from '../projects/store.ts';
import { runIngest } from './ingest.ts';

export type IngestQueue = JobQueue<Ingest>;

/** Ingest runs one project at a time: ffmpeg already uses every core. */
export const createIngestQueue = (store: ProjectStore): IngestQueue =>
  new JobQueue<Ingest>((id, onUpdate) => runIngest(store, id, onUpdate), stageSignature);
