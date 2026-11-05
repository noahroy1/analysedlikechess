import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

// Inputs come from URLs and outputs go to URLs: signed API routes on Node,
// presigned R2 URLs in the cloud. Signatures stay out of error messages.

/** A URL without its query, for messages. */
export const showUrl = (url: string) => url.split('?')[0]!;

async function get(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) throw new Error(`GET ${showUrl(url)}: ${res.status}`);
  return res;
}

/** Saves a URL to a file. */
export async function download(url: string, path: string, signal?: AbortSignal): Promise<void> {
  const res = await get(url, signal);
  await mkdir(dirname(path), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>), createWriteStream(path), ...(signal ? [{ signal }] : []));
}

/** PUTs a file (or bytes) to a URL. */
export async function upload(url: string, from: string | Uint8Array, contentType: string, signal?: AbortSignal): Promise<number> {
  const size = typeof from === 'string' ? (await stat(from)).size : from.byteLength;
  const body = typeof from === 'string' ? (Readable.toWeb(createReadStream(from)) as ReadableStream<Uint8Array>) : from;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'content-length': String(size) },
    body,
    // Node needs this for a streamed request body.
    duplex: 'half',
    ...(signal ? { signal } : {}),
  } as RequestInit);
  if (!res.ok) throw new Error(`PUT ${showUrl(url)}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return size;
}

/** SHA-256 of a URL's bytes, streamed (nothing touches the disk). */
export async function hashUrl(url: string, onProgress: (p: number) => void, signal?: AbortSignal): Promise<string> {
  const res = await get(url, signal);
  const size = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let read = 0;
  for await (const chunk of Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>)) {
    hash.update(chunk as Buffer);
    read += (chunk as Buffer).length;
    if (size) onProgress(Math.min(1, read / size));
  }
  return hash.digest('hex');
}
