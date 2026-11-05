import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { buildCloud, keepAlive, type Cloud, type Env } from './cloud.ts';
import { sizedBody } from './r2-blobs.ts';
import type { ExecutionContext } from './workers.ts';
import type { JobParams, StepRunner } from './workflow-jobs.ts';

let built: { env: Env; cloud: Cloud } | undefined;

/** One set of services per isolate. */
function cloudFor(env: Env): Cloud {
  if (built?.env !== env) built = { env, cloud: buildCloud(env) };
  return built.cloud;
}

/** Runs a job: one Workflow instance per job, named by its id (PLAN-CLOUD.md, Jobs). */
export class JobWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  override async run(event: WorkflowEvent<JobParams>, step: WorkflowStep): Promise<void> {
    const sending: Promise<unknown>[] = [];
    await keepAlive.run(
      (promise) => sending.push(promise),
      () => cloudFor(this.env).jobs.execute(event.payload, step as unknown as StepRunner),
    );
    // The last live updates go out before the run ends.
    await Promise.allSettled(sending);
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Upload parts and the media service's outputs stream into R2 when their length is known.
    if (request.method === 'PUT') sizedBody(request);
    const { app } = cloudFor(env);
    return keepAlive.run(
      (promise) => ctx.waitUntil(promise),
      async () => app.fetch(request, env, ctx),
    );
  },
};
