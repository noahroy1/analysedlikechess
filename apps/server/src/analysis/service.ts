import { readFile } from 'node:fs/promises';
import {
  StyleCorpusSchema,
  type Analysis,
  type AnalyzeRequest,
  type Moment,
  type RegenerateResult,
  type StyleCorpus,
} from '@als/schema';
import { JobQueue, stageSignature } from '../jobs.ts';
import type { ProjectStore } from '../projects/store.ts';
import { missingKeys, type AnalysisConfig } from './config.ts';
import { pendingAnalysis, runAnalysis, type AnalysisOptions } from './pipeline.ts';
import type { Providers } from './providers/index.ts';
import { readRegenUsage, regenerateMoment, type RegenUsage } from './regenerate.ts';

export class AnalysisBusyError extends Error {}

/** The analysis job queue plus Regenerate, sharing one set of providers. */
export class AnalysisService {
  readonly queue: JobQueue<Analysis>;
  readonly config: AnalysisConfig;
  private readonly store: ProjectStore;
  private readonly providers: Providers;
  private readonly style: StyleCorpus;
  private readonly options = new Map<string, AnalysisOptions>();

  constructor(deps: { store: ProjectStore; providers: Providers; config: AnalysisConfig; style: StyleCorpus }) {
    this.store = deps.store;
    this.providers = deps.providers;
    this.config = deps.config;
    this.style = deps.style;
    this.queue = new JobQueue<Analysis>(
      (id, onUpdate) =>
        runAnalysis(deps, id, this.options.get(id) ?? {}, onUpdate).finally(() => this.options.delete(id)),
      stageSignature,
    );
  }

  static async load(store: ProjectStore, providers: Providers, config: AnalysisConfig): Promise<AnalysisService> {
    const style = StyleCorpusSchema.parse(JSON.parse(await readFile(config.styleCorpusPath, 'utf8')));
    return new AnalysisService({ store, providers, config, style });
  }

  missingKeys(): string[] {
    return missingKeys(this.config);
  }

  /** Queues an analysis run. */
  async start(id: string, request: AnalyzeRequest = {}): Promise<void> {
    if (this.queue.has(id)) throw new AnalysisBusyError('analysis is already running');
    const project = await this.store.read(id);
    if (project.ingest.status !== 'done') throw new AnalysisBusyError('wait for ingest to finish');
    await this.store.update(id, (p) => {
      p.analysis = pendingAnalysis({ ...p.analysis, ...(request.secondsPerMove ? { secondsPerMove: request.secondsPerMove } : {}) });
    });
    this.options.set(id, { ...(request.rerun ? { rerun: request.rerun } : {}) });
    this.queue.enqueue(id);
  }

  /** After ingest: analyse new clips on their own when the keys are there. */
  async autoStart(id: string): Promise<void> {
    if (!this.config.autoAnalyze || this.missingKeys().length) return;
    const project = await this.store.read(id).catch(() => undefined);
    if (project?.analysis.status === 'idle') await this.start(id).catch(() => undefined);
  }

  async regenerate(id: string, moment: Moment, instruction?: string): Promise<RegenerateResult> {
    const project = await this.store.read(id);
    return regenerateMoment({ store: this.store, providers: this.providers, config: this.config, style: this.style }, project, moment, instruction);
  }

  regenUsage(id: string): Promise<RegenUsage> {
    return readRegenUsage(this.store, id);
  }
}
