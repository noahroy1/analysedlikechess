import type { JobOf, Project } from '@als/schema';
import type { BlobStore, JobRunner, MediaRunner, ProjectRepo } from '../ports.ts';
import { pendingIngest, runIngest } from './ingest.ts';

export interface IngestServiceDeps {
  repo: ProjectRepo;
  blobs: BlobStore;
  media: MediaRunner;
  jobs: JobRunner;
  /** Called when a clip finishes ingest, e.g. to start analysis on its own. */
  onDone?: (userId: string, projectId: string) => void;
}

/** Ingest jobs: stage 1 of the pipeline, one clip at a time. */
export class IngestService {
  private readonly deps: IngestServiceDeps;

  constructor(deps: IngestServiceDeps) {
    this.deps = deps;
    deps.jobs.register('ingest', async ({ job, userId, report }) => {
      const result = await runIngest(deps, job.projectId, report);
      if (result.status === 'done') deps.onDone?.(userId, job.projectId);
    });
  }

  /** Queues ingest for a project whose state is already pending (a new upload, or a restart picking up where it stopped). */
  start(userId: string, project: Project): { job: JobOf<'ingest'>; created: boolean } {
    return this.deps.jobs.start('ingest', project.id, { userId, state: project.ingest });
  }

  /** Re-runs ingest, or returns the run already going. */
  async restart(userId: string, id: string): Promise<{ job: JobOf<'ingest'>; created: boolean }> {
    const running = this.deps.jobs.find('ingest', id);
    if (running) return { job: running, created: false };
    const project = await this.deps.repo.update(id, (p) => {
      p.ingest = pendingIngest();
    });
    return this.start(userId, project);
  }
}
