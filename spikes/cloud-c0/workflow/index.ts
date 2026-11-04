import { WorkflowEntrypoint, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowEvent } from 'cloudflare:workers';

interface Env { POLL: Workflow; BUILD: string }
type Params = { cycles: number; sleep: string };

/** Stands in for polling an OpenAI background response: a short step, then a durable sleep, repeated. */
export class PollWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const polls: { i: number; at: number; build: string }[] = [];
    for (let i = 0; i < event.payload.cycles; i++) {
      polls.push(await step.do(`poll ${i}`, async () => ({ i, at: Date.now(), build: this.env.BUILD })));
      await step.sleep(`wait ${i}`, event.payload.sleep as never);
    }
    return { polls, finishedBuild: this.env.BUILD };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id) return Response.json(await (await env.POLL.get(id)).status());
    const cycles = Number(url.searchParams.get('cycles') ?? 30);
    const sleep = url.searchParams.get('sleep') ?? '30 seconds';
    const instance = await env.POLL.create({ params: { cycles, sleep } });
    return Response.json({ id: instance.id, build: env.BUILD });
  },
};
