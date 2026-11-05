import type { UploadedPart } from '@als/schema';
import { NotFoundError, UploadIncompleteError, type BlobBody, type BlobHead, type BlobRange, type BlobStore } from '../../server/src/ports.ts';
import type { R2Bucket } from './workers.ts';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Keys are `projects/<id>/<file…>` or `sounds/<file>`, as on Node; nothing else is stored or read. */
function checkKey(key: string): string {
  const parts = key.split('/');
  const [root, ...rest] = parts;
  const ok = parts.every((p) => SAFE_SEGMENT.test(p)) && ((root === 'projects' && rest.length >= 2) || (root === 'sounds' && rest.length === 1));
  if (!ok) throw new NotFoundError(`no blob ${key}`);
  return key;
}

/**
 * Where a multipart upload records its parts: R2's binding can't list them (C1
 * notes), so each part leaves an empty marker carrying its etag. R2's upload
 * ids are opaque, so the folder is named by a hash of the id.
 */
async function partsPrefix(key: string, uploadId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uploadId)));
  const tag = [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${key}.upload-${tag}/`;
}
const partName = (partNumber: number) => `part-${String(partNumber).padStart(5, '0')}`;

type Body = ReadableStream<Uint8Array> | Uint8Array | string;

/** Streams whose length R2 can see: request bodies sent with a Content-Length. */
const sized = new WeakSet<ReadableStream<Uint8Array>>();

/**
 * Marks a request's body as one R2 can stream (it has a Content-Length) and
 * returns it. R2 refuses any other stream, so unmarked streams are read into
 * memory first: fine for upload parts (8 MiB) and the API's own small files.
 */
export function sizedBody(request: Request): ReadableStream<Uint8Array> | null {
  const body = request.body as ReadableStream<Uint8Array> | null;
  if (body && request.headers.get('content-length')) sized.add(body);
  return body;
}

async function r2Value(body: Body): Promise<Body | ArrayBuffer> {
  if (!(body instanceof ReadableStream) || sized.has(body)) return body;
  return new Response(body).arrayBuffer();
}

/**
 * Media in R2. A stream marked by `sizedBody` goes to R2 as it arrives; any
 * other is read into memory first (R2 needs the length). In the cloud the media
 * service writes its large outputs straight to R2 through presigned URLs, not
 * through here.
 */
export class R2BlobStore implements BlobStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async head(key: string): Promise<BlobHead | undefined> {
    const object = await this.bucket.head(checkKey(key));
    return object ? { size: object.size, version: object.etag } : undefined;
  }

  async get(key: string, range?: BlobRange): Promise<BlobBody | undefined> {
    const object = await this.bucket.get(checkKey(key), range && range.length > 0 ? { range: { offset: range.offset, length: range.length } } : {});
    if (!object || !('body' in object)) return undefined;
    return {
      size: object.size,
      version: object.etag,
      body: object.body as unknown as ReadableStream<Uint8Array>,
      ...(range ? { range } : {}),
    };
  }

  /**
   * The whole object in memory. A Worker has 128 MB, so this is for small
   * files; large ones (the source for Gemini) go up in ranges (C0's chunked upload).
   */
  async blob(key: string, type?: string): Promise<Blob | undefined> {
    const object = await this.bucket.get(checkKey(key));
    if (!object || !('body' in object)) return undefined;
    return new Blob([await new Response(object.body as unknown as ReadableStream<Uint8Array>).arrayBuffer()], type ? { type } : {});
  }

  async put(key: string, body: Body): Promise<void> {
    await this.bucket.put(checkKey(key), (await r2Value(body)) as Parameters<R2Bucket['put']>[1]);
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(checkKey(key));
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (!prefix.endsWith('/')) throw new Error('a prefix ends in /');
    const parts = prefix.slice(0, -1).split('/');
    if (parts.length < 2 || !parts.every((p) => SAFE_SEGMENT.test(p)) || !['projects', 'sounds'].includes(parts[0]!)) {
      throw new NotFoundError(`no prefix ${prefix}`);
    }
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) await this.bucket.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  async createMultipart(key: string): Promise<string> {
    const upload = await this.bucket.createMultipartUpload(checkKey(key));
    return upload.uploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: ReadableStream<Uint8Array>): Promise<string> {
    const upload = this.bucket.resumeMultipartUpload(checkKey(key), uploadId);
    let part;
    try {
      part = await upload.uploadPart(partNumber, (await r2Value(body)) as Parameters<typeof upload.uploadPart>[1]);
    } catch (error) {
      throw new NotFoundError(`upload not found (${error instanceof Error ? error.message : String(error)})`);
    }
    // The marker is written after the part is stored, so a listed part is always there.
    await this.bucket.put(`${await partsPrefix(key, uploadId)}${partName(partNumber)}`, '', { customMetadata: { etag: part.etag } });
    return part.etag;
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    checkKey(key);
    const parts: UploadedPart[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: await partsPrefix(key, uploadId), include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) {
        const partNumber = Number(object.key.slice(-5));
        const etag = object.customMetadata?.etag;
        if (Number.isInteger(partNumber) && etag) parts.push({ partNumber, etag });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    const stored = new Map((await this.listParts(key, uploadId)).map((p) => [p.partNumber, p.etag]));
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    ordered.forEach((p, i) => {
      if (p.partNumber !== i + 1) throw new UploadIncompleteError(`part ${i + 1} is missing`);
      if (stored.get(p.partNumber) !== p.etag.replaceAll('"', '')) throw new UploadIncompleteError(`part ${p.partNumber} does not match what was uploaded`);
    });
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    await upload.complete(ordered.map((p) => ({ partNumber: p.partNumber, etag: stored.get(p.partNumber)! })));
    await this.deletePrefix(await partsPrefix(key, uploadId));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.bucket.resumeMultipartUpload(checkKey(key), uploadId).abort().catch(() => undefined);
    await this.deletePrefix(await partsPrefix(key, uploadId));
  }
}
