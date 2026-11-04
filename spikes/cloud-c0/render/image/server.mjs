// Container side of the render spike: fetch inputs, serve them on localhost, render with the server's settings, upload.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, totalmem } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const WORK = process.env.WORK_DIR ?? '/work';
const BUNDLE = new URL('./bundle', import.meta.url).pathname;
// The same settings as apps/server/src/render/renders.ts.
const ENCODING = { codec: 'h264', crf: 18, x264Preset: 'medium', audioCodec: 'aac', audioBitrate: '320k', colorSpace: 'bt709', jpegQuality: 95 };
const state = { status: 'idle', machine: { cpus: cpus().length, memGiB: +(totalmem() / 2 ** 30).toFixed(1) } };
const mark = (key, start) => { state.timings[key] = +((performance.now() - start) / 1000).toFixed(1); };

// Range-capable static server for the renderer's browser (it seeks in the clip).
createServer(async (req, res) => {
  const path = normalize(join(WORK, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(WORK)) return res.writeHead(403).end();
  let size;
  try { size = (await stat(path)).size; } catch { return res.writeHead(404).end(); }
  const type = path.endsWith('.mov') ? 'video/quicktime' : path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.mp3') ? 'audio/mpeg' : path.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': type, 'Access-Control-Allow-Origin': '*' };
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
}).listen(9000, '127.0.0.1');

async function render(job) {
  const t0 = performance.now();
  Object.assign(state, { status: 'downloading', timings: {}, error: undefined, progress: 0 });
  await Promise.all(job.inputs.map(async ({ path, url }) => {
    const res = await fetch(url, { headers: job.headers });
    if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
    await mkdir(dirname(join(WORK, path)), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(join(WORK, path)));
  }));
  mark('downloadSec', t0);

  const { ensureBrowser, renderMedia, selectComposition } = await import('@remotion/renderer');
  let t = performance.now();
  state.status = 'browser';
  await ensureBrowser();
  mark('browserSec', t);

  t = performance.now();
  state.status = 'rendering';
  const shared = { serveUrl: BUNDLE, inputProps: job.props, timeoutInMilliseconds: 120_000, logLevel: 'warn',
    chromiumOptions: { disableWebSecurity: true, enableMultiProcessOnLinux: true } };
  const composition = await selectComposition({ ...shared, id: 'Episode' });
  state.frames = composition.durationInFrames;
  const output = join(WORK, 'out.mp4');
  await renderMedia({ ...shared, ...ENCODING, composition, scale: 1, outputLocation: output,
    ...(job.concurrency ? { concurrency: job.concurrency } : {}),
    onProgress: ({ progress, renderedFrames }) => { state.progress = +progress.toFixed(3); state.renderedFrames = renderedFrames; } });
  mark('renderSec', t);

  t = performance.now();
  state.status = 'uploading';
  const { size } = await stat(output);
  state.bytes = size;
  if (job.uploadUrl) {
    const res = await fetch(job.uploadUrl, { method: 'PUT', headers: { ...job.headers, 'Content-Length': String(size), 'Content-Type': 'video/mp4' }, body: Readable.toWeb(createReadStream(output)), duplex: 'half' });
    if (!res.ok) throw new Error(`upload: ${res.status} ${await res.text()}`);
  }
  mark('uploadSec', t);
  mark('totalSec', t0);
  state.status = 'done';
}

createServer(async (req, res) => {
  const send = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (req.url === '/ping') return send(200, { ok: true });
  if (req.url === '/status') return send(200, state);
  if (req.url === '/render' && req.method === 'POST') {
    if (['downloading', 'browser', 'rendering', 'uploading'].includes(state.status)) return send(409, state);
    let body = '';
    for await (const chunk of req) body += chunk;
    render(JSON.parse(body)).catch((e) => Object.assign(state, { status: 'failed', error: String(e?.stack ?? e) }));
    return send(202, { started: true });
  }
  send(404, { error: 'not found' });
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
console.log('render spike listening');
