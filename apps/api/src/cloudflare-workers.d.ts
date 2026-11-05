// The Workers runtime module the entry imports, typed for this package's Node
// typecheck (the Workers types declare it only alongside their globals).
declare module 'cloudflare:workers' {
  export type WorkflowEvent<T> = { payload: Readonly<T>; timestamp: Date; instanceId: string; workflowName: string };
  export abstract class WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: object, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: string | number): Promise<void>;
  }
  export abstract class WorkflowEntrypoint<Env = unknown, T = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<unknown>;
  }
}
