interface Env { BLOBS: R2Bucket; GEMINI_API_KEY: string; SPIKE_TOKEN: string }
const BASE = 'https://generativelanguage.googleapis.com';

/** Streams an R2 object into Gemini's Files API (resumable upload), waits for ACTIVE, then deletes it. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${env.SPIKE_TOKEN}`) return new Response('forbidden', { status: 403 });
    const key = new URL(request.url).searchParams.get('key') ?? 'bb1/proxy.mp4';
    const type = key.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    const object = await env.BLOBS.get(key);
    if (!object) return new Response('not found', { status: 404 });
    const t0 = performance.now();
    const start = await fetch(`${BASE}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': env.GEMINI_API_KEY,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(object.size),
        'X-Goog-Upload-Header-Content-Type': type,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: `als-spike-${key}` } }),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl) return Response.json({ step: 'start', status: start.status, body: await start.text() }, { status: 502 });
    // 8 MiB chunks like the SDK, each read from R2 as a byte range, so memory stays flat for any size.
    const CHUNK = 8 * 1024 * 1024;
    let up: Response | undefined;
    for (let offset = 0; offset < object.size; offset += CHUNK) {
      const length = Math.min(CHUNK, object.size - offset);
      const last = offset + length >= object.size;
      const part = await env.BLOBS.get(key, { range: { offset, length } });
      up = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Length': String(length), 'X-Goog-Upload-Offset': String(offset), 'X-Goog-Upload-Command': last ? 'upload, finalize' : 'upload' },
        body: part!.body,
      });
      const status = up.headers.get('x-goog-upload-status');
      if (!last && status !== 'active') return Response.json({ step: 'chunk', offset, status, http: up.status, body: await up.text() }, { status: 502 });
      if (!last) await up.arrayBuffer();
    }
    const uploaded = (await up!.json()) as { file?: { name: string; uri: string; state: string } };
    const uploadSec = (performance.now() - t0) / 1000;
    if (!uploaded.file) return Response.json({ step: 'upload', status: up!.status, uploaded }, { status: 502 });
    let file = uploaded.file;
    const t1 = performance.now();
    while (file.state === 'PROCESSING' && performance.now() - t1 < 300_000) {
      await new Promise((r) => setTimeout(r, 2000));
      file = (await (await fetch(`${BASE}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } })).json()) as typeof file;
    }
    const processSec = (performance.now() - t1) / 1000;
    const del = await fetch(`${BASE}/v1beta/${file.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    return Response.json({ key, bytes: object.size, state: file.state, uploadSec, processSec, deleted: del.ok });
  },
};
