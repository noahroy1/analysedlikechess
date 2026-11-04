import {
  projectFormat,
  type AnalyzeRequest,
  type EvaluateRequest,
  type EvaluateResult,
  type Format,
  type JobOf,
  type Moment,
  type RegenerateResult,
  type RegionsResult,
  type StyleCorpus,
} from '@als/schema';
import { NotReadyError, type BlobStore, type JobRunner, type MediaRunner, type ProjectRepo, type UsageLog } from '../ports.ts';
import type { Spend } from '../spend.ts';
import { missingKeys, type AnalysisConfig } from './config.ts';
import { pendingAnalysis, runAnalysis, type AnalysisDeps, type AnalysisOptions } from './pipeline.ts';
import type { Providers } from './providers/index.ts';
import { reevaluate } from './reevaluate.ts';
import { findRegions } from './regions.ts';
import { regenerateMoment } from './regenerate.ts';

export interface AnalysisServiceDeps {
  repo: ProjectRepo;
  blobs: BlobStore;
  media: MediaRunner;
  jobs: JobRunner;
  usage: UsageLog;
  spend: Spend;
  providers: Providers;
  config: AnalysisConfig;
  style: StyleCorpus;
}

/** Analysis jobs plus the editor's own AI calls (Regenerate, Re-evaluate, regions), sharing one set of providers. */
export class AnalysisService {
  readonly config: AnalysisConfig;
  private readonly deps: AnalysisServiceDeps;

  constructor(deps: AnalysisServiceDeps) {
    this.deps = deps;
    this.config = deps.config;
    const pipeline: AnalysisDeps = deps;
    deps.jobs.register('analysis', async ({ job, userId, request, report }) => {
      await runAnalysis(pipeline, job.projectId, (request ?? {}) as AnalysisOptions, { userId, check: () => deps.spend.check(userId) }, report);
    });
  }

  missingKeys(): string[] {
    return missingKeys(this.config);
  }

  /** Starts an analysis run, or returns the one already pending or running (`created: false`). */
  async start(userId: string, id: string, request: AnalyzeRequest = {}): Promise<{ job: JobOf<'analysis'>; created: boolean }> {
    const { repo, jobs, spend } = this.deps;
    const running = jobs.find('analysis', id);
    if (running) return { job: running, created: false };
    const project = await repo.read(id);
    if (project.ingest.status !== 'done') throw new NotReadyError('Wait for ingest to finish.');
    await spend.check(userId);
    const pending = await repo.update(id, (p) => {
      p.analysis = pendingAnalysis(p.analysis);
      if (request.secondsPerMove) p.analysis.secondsPerMove = request.secondsPerMove;
      else if (request.secondsPerMove === null) delete p.analysis.secondsPerMove;
    });
    const options: AnalysisOptions = request.rerun ? { rerun: request.rerun } : {};
    return jobs.start('analysis', id, { userId, state: pending.analysis, request: options });
  }

  /** After ingest: analyse new clips on their own when the keys are there. */
  async autoStart(userId: string, id: string): Promise<void> {
    if (!this.config.autoAnalyze || this.missingKeys().length) return;
    const project = await this.deps.repo.read(id).catch(() => undefined);
    if (project?.analysis.status === 'idle') await this.start(userId, id).catch(() => undefined);
  }

  async regenerate(userId: string, id: string, moment: Moment, instruction?: string, format?: Format): Promise<RegenerateResult> {
    const { repo, spend, usage } = this.deps;
    const project = await repo.read(id);
    await spend.check(userId);
    const result = await regenerateMoment(this.deps, project, moment, instruction, format ?? projectFormat(project));
    await usage.record({ userId, projectId: id, call: 'regenerate', model: result.model, usage: result.usage, costUsd: result.costUsd });
    return result;
  }

  async evaluate(userId: string, id: string, request: EvaluateRequest): Promise<EvaluateResult> {
    const { repo, spend, usage } = this.deps;
    const project = await repo.read(id);
    await spend.check(userId);
    const result = await reevaluate(this.deps, project, request);
    await usage.record({ userId, projectId: id, call: 'evaluate', model: result.model, usage: result.usage, costUsd: result.costUsd });
    return result;
  }

  /** Faces and subject on a move's frozen frame, for the editor to place its card. Saves nothing. A cached frame is free and never refused. */
  async regions(userId: string, id: string, moment: Moment): Promise<RegionsResult> {
    const { repo, spend, usage } = this.deps;
    const project = await repo.read(id);
    const result = await findRegions({ ...this.deps, check: () => spend.check(userId) }, project, moment);
    if (result.costUsd > 0) {
      await usage.record({ userId, projectId: id, call: 'regions', model: result.model, usage: result.usage, costUsd: result.costUsd });
    }
    return result;
  }
}
