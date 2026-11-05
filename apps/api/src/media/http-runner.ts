import { API_PREFIX, MediaTaskStatusSchema, ProbeResultSchema, shotThumbnailFile, type MediaTask, type MediaTaskEvent, type MediaTaskResult } from '@als/schema';
import { MEDIA_PRINCIPAL, mediaInScope, mediaOutScope, mediaTaskScope, type MediaSigner } from '../api/media-urls.ts';
import { NotAVideoError, projectKey, type BlobStore, type MediaRunner } from '../ports.ts';

export interface HttpMediaOptions {
  /** The media service's base URLs; tasks are spread over them in turn (one is the usual). */
  urls: string[];
  /** Where quick calls (probe, frame, portrait) go; default the task URLs in turn. */
  quickUrl?: string;
  signer: MediaSigner;
  blobs: BlobStore;
  /** The API's origin as the media service reaches it: inputs, outputs and callbacks are under it. */
  origin: string;
  /**
   * Whether tasks report to a callback. The Worker turns them off: a callback
   * lands on whichever instance answers, not the one waiting, so it polls the
   * task's status instead (which carries progress too).
   */
  callbacks?: boolean;
  /** How often a task's status is asked for: a safety net with callbacks, the only signal without. */
  pollMs?: number;
  /** How requests reach the service (the Worker's Container binding); default `fetch`. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** A task the service lost (it restarted) is noticed within this long, even if no callback comes. */
const POLL_MS = 10_000;
/** While the service starts (`pnpm dev` starts both at once), refused connections are retried this long. */
const CONNECT_WAIT_MS = 30_000;

class MediaServiceError extends Error {}

interface Pending {
  onEvent(event: MediaTaskEvent): void;
}

/**
 * The media service over HTTP (contract in packages/schema/src/media.ts). It
 * never shares a disk with the API: every input is a signed GET of one file,
 * every output a signed PUT, and long tasks report to a signed callback that
 * `deliver()` hands back to the waiting call. The Worker reaches the Containers the same way (`fetch`, media-container.ts).
 */
export class HttpMediaRunner implements MediaRunner {
  private readonly options: HttpMediaOptions;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly pollMs: number;
  private readonly pending = new Map<string, Pending>();
  private next = 0;

  constructor(options: HttpMediaOptions) {
    if (!options.urls.length) throw new Error('no media service URL');
    this.options = { ...options, urls: options.urls.map((u) => u.replace(/\/+$/, '')), ...(options.quickUrl ? { quickUrl: options.quickUrl.replace(/\/+$/, '') } : {}) };
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.pollMs = options.pollMs ?? (options.callbacks === false ? 1_000 : POLL_MS);
  }

  private async signed(path: string, scope: string): Promise<string> {
    const { query } = await this.options.signer.sign(scope, MEDIA_PRINCIPAL);
    return `${this.options.origin}${API_PREFIX}${path}?${query}`;
  }

  private input(projectId: string, file: string) {
    return this.signed(`/media/in/${projectId}/${file}`, mediaInScope(projectId, file));
  }

  private output(projectId: string, file: string) {
    return this.signed(`/media/out/${projectId}/${file}`, mediaOutScope(projectId, file));
  }

  private pick(): string {
    const { urls } = this.options;
    return urls[this.next++ % urls.length]!;
  }

  /** A request to the service, retrying refused connections while it starts. */
  private async request(base: string, path: string, init?: RequestInit): Promise<Response> {
    const until = Date.now() + CONNECT_WAIT_MS;
    for (;;) {
      try {
        return await this.fetchImpl(`${base}/v1${path}`, init);
      } catch (error) {
        const code = (error as { cause?: { code?: string } }).cause?.code;
        if (code !== 'ECONNREFUSED' || Date.now() > until || init?.signal?.aborted) {
          throw new MediaServiceError(`The media service at ${base} is not answering (${code ?? (error instanceof Error ? error.message : error)}).`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  /** A quick call answered in the response. */
  private async call(path: string, body: unknown): Promise<Response> {
    const res = await this.request(this.options.quickUrl ?? this.pick(), path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return res;
    const error = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (error.code === 'not_a_video') throw new NotAVideoError(error.error ?? 'not a video');
    throw new MediaServiceError(`media ${path}: ${error.error ?? res.status}`);
  }

  /** The service's callback for a task arrived (POST /media/tasks/:id). False when no call is waiting for it. */
  deliver(taskId: string, event: MediaTaskEvent): boolean {
    const pending = this.pending.get(taskId);
    pending?.onEvent(event);
    return pending !== undefined;
  }

  /** Starts a task and waits for its result, passing progress on; aborting cancels it on the service. */
  private async task(body: MediaTask, options: { onProgress?: (p: number, stage?: string) => void; signal?: AbortSignal } = {}): Promise<MediaTaskResult> {
    const { onProgress, signal } = options;
    signal?.throwIfAborted();
    const id = crypto.randomUUID().replaceAll('-', '');
    const base = this.pick();
    const callback = this.options.callbacks === false ? undefined : await this.signed(`/media/tasks/${id}`, mediaTaskScope(id));
    return new Promise<MediaTaskResult>((resolve, reject) => {
      let settled = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        settle();
      };
      const onEvent = (event: MediaTaskEvent) => {
        if (event.type === 'progress') {
          if (!settled) onProgress?.(event.progress, event.stage);
        } else if (event.type === 'done') finish(() => resolve(event.result));
        else if (event.code === 'not_a_video') finish(() => reject(new NotAVideoError(event.error)));
        else finish(() => reject(new MediaServiceError(event.error)));
      };
      const abort = () => {
        finish(() => reject(signal!.reason));
        void this.request(base, `/tasks/${id}/cancel`, { method: 'POST' }).catch(() => undefined);
      };
      // A safety net for a callback that never comes (the service restarted, or cannot reach us). It starts
      // once the service has the task: a container still starting could otherwise answer a poll first, with 404.
      const startPolling = () => setInterval(() => {
        void this.request(base, `/tasks/${id}`)
          .then(async (res) => {
            if (res.status === 404) return finish(() => reject(new MediaServiceError('The media service lost this task (did it restart?).')));
            const status = MediaTaskStatusSchema.parse(await res.json());
            if (status.status === 'running' && !callback) onEvent({ type: 'progress', id, progress: status.progress, ...(status.stage ? { stage: status.stage } : {}) });
            else if (status.status === 'done') onEvent({ type: 'done', id, result: status.result! });
            else if (status.status === 'failed') onEvent({ type: 'failed', id, error: status.error ?? 'failed', code: status.code ?? 'failed' });
          })
          .catch(() => undefined);
      }, this.pollMs);
      this.pending.set(id, { onEvent });
      signal?.addEventListener('abort', abort, { once: true });
      this.request(base, '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...(callback ? { callback } : {}), ...body }) })
        .then(async (res) => {
          if (!res.ok) {
            const error = (await res.json().catch(() => ({}))) as { error?: string };
            finish(() => reject(new MediaServiceError(`media ${body.op}: ${error.error ?? res.status}`)));
          } else if (!settled) poll = startPolling();
        })
        .catch((error: unknown) => finish(() => reject(error)));
    });
  }

  async probe({ projectId, file }: Parameters<MediaRunner['probe']>[0]) {
    return ProbeResultSchema.parse(await (await this.call('/probe', { input: await this.input(projectId, file) })).json());
  }

  async hash({ projectId, file }: Parameters<MediaRunner['hash']>[0], onProgress: (p: number) => void) {
    const { sha256 } = await this.task({ op: 'hash', input: await this.input(projectId, file) }, { onProgress });
    if (!sha256) throw new MediaServiceError('the hash task returned no hash');
    return sha256;
  }

  async proxy(input: Parameters<MediaRunner['proxy']>[0], onProgress: (p: number) => void) {
    const { projectId } = input;
    await this.task(
      { op: 'proxy', input: await this.input(projectId, input.file), output: await this.output(projectId, input.output), fps: input.fps, durationSec: input.durationSec },
      { onProgress },
    );
  }

  async audio(input: Parameters<MediaRunner['audio']>[0], onProgress: (p: number) => void) {
    const { projectId } = input;
    await this.task({ op: 'audio', input: await this.input(projectId, input.file), output: await this.output(projectId, input.output), durationSec: input.durationSec }, { onProgress });
  }

  async shots(input: Parameters<MediaRunner['shots']>[0], onProgress: (p: number) => void) {
    const { shots } = await this.task({ op: 'shots', input: await this.input(input.projectId, input.file), durationSec: input.durationSec }, { onProgress });
    if (!shots) throw new MediaServiceError('the shots task returned no shots');
    return shots;
  }

  async thumbnails(input: Parameters<MediaRunner['thumbnails']>[0], onProgress: (p: number) => void) {
    const { projectId, shots } = input;
    // The old set goes first: shots have changed, so none of it is right any more.
    await this.options.blobs.deletePrefix(projectKey(projectId, 'frames/'));
    const outputs = await Promise.all(shots.map((_, i) => this.output(projectId, shotThumbnailFile(i))));
    await this.task({ op: 'thumbnails', input: await this.input(projectId, input.file), shots, outputs }, { onProgress });
  }

  async frame(input: Parameters<MediaRunner['frame']>[0]): Promise<Uint8Array> {
    const res = await this.call('/frame', { input: await this.input(input.projectId, input.file), frame: input.frame, fps: input.fps });
    return new Uint8Array(await res.arrayBuffer());
  }

  async portrait(input: Parameters<MediaRunner['portrait']>[0]) {
    const { projectId, source } = input;
    await this.call('/portrait', {
      input: await this.input(projectId, input.file),
      output: await this.output(projectId, input.output),
      request: input.request,
      source: { width: source.width, height: source.height, durationSec: source.durationSec },
    });
  }

  async renderChunk(input: Parameters<MediaRunner['renderChunk']>[0]) {
    const { projectId, onProgress, signal } = input;
    const { seconds } = await this.task(
      {
        op: 'render-chunk',
        props: input.props as Record<string, unknown>,
        scale: input.scale,
        frameRange: input.frameRange,
        encoding: input.encoding,
        video: await this.output(projectId, input.video),
        audio: await this.output(projectId, input.audio),
        // Chunks are spread over the service URLs; those sharing one split its CPU.
        share: Math.ceil(input.chunks / this.options.urls.length),
      },
      { onProgress: (progress, stage) => onProgress({ progress, ...(stage ? { stage } : {}) }), signal },
    );
    return { seconds };
  }

  async combine(input: Parameters<MediaRunner['combine']>[0]) {
    const { projectId, onProgress, signal } = input;
    const { sizeBytes, seconds } = await this.task(
      {
        op: 'combine',
        videos: await Promise.all(input.videos.map((file) => this.input(projectId, file))),
        audios: await Promise.all(input.audios.map((file) => this.input(projectId, file))),
        output: await this.output(projectId, input.output),
        fps: input.fps,
        framesPerChunk: input.framesPerChunk,
        durationInFrames: input.durationInFrames,
        encoding: input.encoding,
      },
      { onProgress: (progress, stage) => onProgress({ progress, ...(stage ? { stage } : {}) }), signal },
    );
    return { sizeBytes: sizeBytes ?? 0, seconds };
  }

  warmUp(): void {
    for (const base of this.options.urls) {
      void this.request(base, '/warm', { method: 'POST' }).catch((error: unknown) => console.warn('media service not warmed up:', error instanceof Error ? error.message : error));
    }
  }
}
