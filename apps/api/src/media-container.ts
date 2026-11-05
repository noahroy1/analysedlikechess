import { Container, getContainer } from '@cloudflare/containers';

/**
 * The media service (`apps/media`, its Dockerfile) as Cloudflare Containers
 * (PLAN-CLOUD.md, "Media service"). Two classes on one image, sized and slept
 * for their work:
 * - `MediaTasks`: ingest passes, render chunks and the join, on a fixed pool of
 *   named instances so a render's chunks run on separate machines. Idle
 *   instances bill until `sleepAfter`, so they sleep soon after the last call
 *   (the runner polls a task every second, which keeps its instance awake).
 * - `MediaQuick`: probe, frame grabs and portrait crops, answered in the
 *   response; one smaller instance kept warm, since a cold start (about 20 s in
 *   C0) would hold up card placement.
 * Dev runs the same service as a local process instead (`MEDIA_URL`).
 */
export class MediaTasks extends Container {
  override defaultPort = 8080;
  // TODO(open-decision): C4 sets this (and the pool size) from real renders and the bill.
  override sleepAfter = '30s';
}

export class MediaQuick extends Container {
  override defaultPort = 8080;
  override sleepAfter = '10m';
}

/** Render chunks go to this many task instances at most (DEFAULT_RENDER_SPLIT's cap). */
export const MEDIA_TASK_INSTANCES = 4;

const HOST = 'media.internal';

/** The runner's service URLs for the Container bindings: a pool of task instances and the quick one. */
export const containerUrls = () => ({
  urls: Array.from({ length: MEDIA_TASK_INSTANCES }, (_, i) => `http://tasks-${i}.${HOST}`),
  quickUrl: `http://quick.${HOST}`,
});

/** A Durable Object namespace as the containers package types it (its Workers globals aren't loaded here). */
type Namespace<T extends Container> = Parameters<typeof getContainer<T>>[0];

export interface MediaBindings {
  MEDIA_TASKS: Namespace<MediaTasks>;
  MEDIA_QUICK: Namespace<MediaQuick>;
}

/** Sends a runner request to the instance its URL names (`tasks-<n>` or `quick`). */
export function containerFetch(bindings: MediaBindings) {
  return (url: string, init?: RequestInit): Promise<Response> => {
    const name = new URL(url).hostname.split('.')[0]!;
    const binding = name === 'quick' ? bindings.MEDIA_QUICK : bindings.MEDIA_TASKS;
    return getContainer(binding, name).fetch(new Request(url, init));
  };
}
