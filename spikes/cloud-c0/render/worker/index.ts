import { Container, getContainer } from '@cloudflare/containers';

interface Env { RENDERER: DurableObjectNamespace<Renderer>; BLOBS: R2Bucket; SPIKE_TOKEN: string }

export class Renderer extends Container {
  defaultPort = 8080;
  sleepAfter = '15m';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${env.SPIKE_TOKEN}`) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);
    const container = getContainer(env.RENDERER, url.searchParams.get('name') ?? 'bb1');

    if (url.pathname.startsWith('/blob/')) {
      const key = decodeURIComponent(url.pathname.slice('/blob/'.length));
      if (request.method === 'PUT') {
        const t = performance.now();
        const put = await env.BLOBS.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') ?? undefined } });
        return Response.json({ key, size: put?.size, sec: (performance.now() - t) / 1000 });
      }
      const object = await env.BLOBS.get(key);
      if (!object) return new Response('not found', { status: 404 });
      return new Response(object.body, { headers: { 'content-length': String(object.size) } });
    }

    if (url.pathname === '/start' && request.method === 'POST') {
      const job = (await request.json()) as { inputs: { path: string; key: string }[]; props: unknown; concurrency?: number };
      const t = performance.now();
      const res = await container.fetch(new Request('http://container/render', {
        method: 'POST',
        body: JSON.stringify({
          inputs: job.inputs.map(({ path, key }) => ({ path, url: `${url.origin}/blob/${key}` })),
          props: job.props,
          concurrency: job.concurrency,
          uploadUrl: `${url.origin}/blob/out/bb1-cloud.mp4`,
          headers: { authorization: `Bearer ${env.SPIKE_TOKEN}` },
        }),
      }));
      // The first fetch starts the container, so this is the cold start plus the request.
      return Response.json({ status: res.status, body: await res.json(), startSec: (performance.now() - t) / 1000 });
    }
    if (url.pathname === '/status') return container.fetch(new Request('http://container/status'));
    if (url.pathname === '/ping') {
      const t = performance.now();
      const res = await container.fetch(new Request('http://container/ping'));
      return Response.json({ status: res.status, sec: (performance.now() - t) / 1000 });
    }
    return new Response('not found', { status: 404 });
  },
};
