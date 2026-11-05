import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus } from 'node:os';
import { extname, join } from 'node:path';
import type { MediaTask } from '@als/schema';
import type { EpisodeBundle } from './bundle.ts';
import { download, showUrl, upload } from './io.ts';
import type { StepContext } from './ingest.ts';

// Renders split by frame range (Remotion's distributed rendering: each chunk an
// H.264 transport stream plus its AAC audio, then `combineChunks` joins them
// without re-encoding). Each chunk can run on its own instance.

type Task<Op extends MediaTask['op']> = Extract<MediaTask, { op: Op }>;

/** Must match EPISODE_COMPOSITION in packages/composition/src/render-entry.tsx. */
const COMPOSITION_ID = 'Episode';

/** Time allowed for the clip and sounds to load into a frame. A long source can take a while to open. */
const LOAD_TIMEOUT_MS = 120_000;

/**
 * The renderer's browser loads media from a server on localhost that is not the
 * bundle's. It is a local, single-purpose browser, so cross-origin checks are off.
 */
const chromiumOptions = { disableWebSecurity: true };

/** Every option a chunk and the join must agree on (see remotion.dev/docs/distributed-rendering). */
const CHUNK_CODEC = 'h264-ts';
const AUDIO_CODEC = 'aac';
const COLOR_SPACE = 'bt709';

let browser: Promise<unknown> | undefined;

/** Downloads Chrome Headless Shell the first time (under the nearest package.json). */
export function ensureBrowser(): Promise<unknown> {
  browser ??= import('@remotion/renderer').then(({ ensureBrowser: ensure }) => ensure());
  browser.catch(() => {
    browser = undefined;
  });
  return browser;
}

/** Remotion's default concurrency (half the cores, at most 8), shared among the chunks on this machine. */
function concurrency(share: number): number {
  return Math.max(1, Math.round(Math.min(8, Math.max(1, cpus().length / 2)) / share));
}

/**
 * Every http(s) URL in the props, downloaded into `dir` and served from
 * localhost with Range support, so the renderer never waits on the network and
 * a frame always finds its media. Returns the props with the local URLs.
 */
async function localizeMedia(props: Record<string, unknown>, dir: string, signal: AbortSignal): Promise<{ props: Record<string, unknown>; server: Server }> {
  const urls = new Map<string, string>();
  const collect = (value: unknown) => {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
      if (!urls.has(value)) urls.set(value, `${urls.size}${extname(showUrl(value).split('/').pop() ?? '').toLowerCase()}`);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(props);
  await Promise.all([...urls].map(([url, name]) => download(url, join(dir, name), signal)));

  const names = new Set(urls.values());
  const server = createServer((req, res) => void serveFile(dir, names, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const swap = (value: unknown): unknown => {
    if (typeof value === 'string') return urls.has(value) ? `${origin}/${urls.get(value)}` : value;
    if (Array.isArray(value)) return value.map(swap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
    return value;
  };
  return { props: swap(props) as Record<string, unknown>, server };
}

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' };

async function serveFile(dir: string, names: Set<string>, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(1));
  if (!names.has(name)) return res.writeHead(404).end();
  const path = join(dir, name);
  const { size } = await stat(path);
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': TYPES[extname(name)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
}

/** Renders one chunk: frames [from, to] of the episode, video and audio apart. */
export async function renderChunk(task: Task<'render-chunk'>, bundle: EpisodeBundle, { work, progress, signal }: StepContext): Promise<void> {
  const { makeCancelSignal, renderMedia, selectComposition } = await import('@remotion/renderer');
  const { cancelSignal, cancel } = makeCancelSignal();
  signal.addEventListener('abort', () => cancel(), { once: true });
  if (signal.aborted) cancel();

  progress(0, 'Downloading media');
  const { props, server } = await localizeMedia(task.props, join(work, 'media'), signal);
  try {
    progress(0, 'Preparing the browser');
    await ensureBrowser();
    signal.throwIfAborted();
    progress(0, 'Bundling');
    const serveUrl = await bundle.serveUrl();
    signal.throwIfAborted();

    const shared = { serveUrl, inputProps: props, timeoutInMilliseconds: LOAD_TIMEOUT_MS, chromiumOptions, logLevel: 'warn' } as const;
    const composition = await selectComposition({ ...shared, id: COMPOSITION_ID });
    const [from, to] = task.frameRange;
    if (to >= composition.durationInFrames || from > to) {
      throw new Error(`frames ${from}-${to} are outside the episode's ${composition.durationInFrames}`);
    }
    progress(0, 'Rendering frames');
    const video = join(work, 'chunk.ts');
    const audio = join(work, 'chunk.aac');
    const frames = to - from + 1;
    await renderMedia({
      ...shared,
      composition,
      codec: CHUNK_CODEC,
      audioCodec: AUDIO_CODEC,
      audioBitrate: task.encoding.audioBitrate as `${number}k`,
      crf: task.encoding.crf,
      x264Preset: task.encoding.x264Preset,
      jpegQuality: task.encoding.jpegQuality,
      colorSpace: COLOR_SPACE,
      scale: task.scale,
      frameRange: [from, to],
      // The whole episode is being rendered, so every chunk counts from its frame 0.
      compositionStart: 0,
      numberOfGifLoops: null,
      enforceAudioTrack: true,
      separateAudioTo: audio,
      forSeamlessAacConcatenation: true,
      concurrency: concurrency(task.share),
      outputLocation: video,
      cancelSignal,
      onProgress: ({ progress: p, renderedFrames }) => progress(Math.min(p, 0.97), renderedFrames < frames ? 'Rendering frames' : 'Encoding'),
      onBrowserLog: (log) => {
        if (log.type === 'error') console.warn(`render chunk ${from}-${to}:`, log.text);
      },
    });
    progress(0.97, 'Uploading');
    await upload(task.video, video, 'video/mp2t', signal);
    await upload(task.audio, audio, 'audio/aac', signal);
  } finally {
    server.close();
  }
}

/** Joins the chunks into the MP4 (the video is remuxed, the AAC joined seamlessly) and PUTs it. */
export async function combine(task: Task<'combine'>, { work, progress, signal }: StepContext): Promise<number> {
  const { combineChunks, makeCancelSignal } = await import('@remotion/renderer');
  const { cancelSignal, cancel } = makeCancelSignal();
  signal.addEventListener('abort', () => cancel(), { once: true });
  if (signal.aborted) cancel();
  if (task.videos.length !== task.audios.length) throw new Error('one audio file per chunk');

  progress(0, 'Joining');
  const name = (i: number) => String(i).padStart(4, '0');
  const videoFiles = task.videos.map((_, i) => join(work, `chunk-${name(i)}.ts`));
  const audioFiles = task.audios.map((_, i) => join(work, `chunk-${name(i)}.aac`));
  await Promise.all([
    ...task.videos.map((url, i) => download(url, videoFiles[i]!, signal)),
    ...task.audios.map((url, i) => download(url, audioFiles[i]!, signal)),
  ]);
  const output = join(work, 'episode.mp4');
  await combineChunks({
    outputLocation: output,
    videoFiles,
    audioFiles,
    codec: 'h264',
    audioCodec: AUDIO_CODEC,
    audioBitrate: task.encoding.audioBitrate as `${number}k`,
    fps: task.fps,
    framesPerChunk: task.framesPerChunk,
    preferLossless: false,
    compositionDurationInFrames: task.durationInFrames,
    numberOfGifLoops: null,
    cancelSignal,
    logLevel: 'warn',
    onProgress: ({ totalProgress }) => progress(Math.min(totalProgress, 0.95), 'Joining'),
  });
  progress(0.95, 'Uploading');
  return upload(task.output, output, 'video/mp4', signal);
}
