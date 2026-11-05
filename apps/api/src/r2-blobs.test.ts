import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { NotFoundError, UploadIncompleteError } from '../../server/src/ports.ts';
import { R2BlobStore } from './r2-blobs.ts';
import type { R2Bucket } from './workers.ts';

// R2 as workerd runs it locally (Wrangler's platform proxy, nothing persisted).

let platform: Awaited<ReturnType<typeof getPlatformProxy<{ MEDIA: R2Bucket }>>>;
let blobs: R2BlobStore;

beforeAll(async () => {
  platform = await getPlatformProxy<{ MEDIA: R2Bucket }>({ configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), persist: false });
  blobs = new R2BlobStore(platform.env.MEDIA);
}, 60_000);

afterAll(async () => {
  await platform?.dispose();
});

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
const MiB = 1024 * 1024;

describe('R2BlobStore', () => {
  it('stores, reads whole and by range, and deletes', async () => {
    await blobs.put('projects/p1/notes.json', '{"a":1}');
    await blobs.put('projects/p1/bytes.bin', new TextEncoder().encode('0123456789'));
    const head = await blobs.head('projects/p1/bytes.bin');
    expect(head?.size).toBe(10);
    expect(head?.version).toBeTruthy();

    const whole = await blobs.get('projects/p1/bytes.bin');
    expect(await text(whole!.body)).toBe('0123456789');
    const part = await blobs.get('projects/p1/bytes.bin', { offset: 2, length: 3 });
    expect(part!.range).toEqual({ offset: 2, length: 3 });
    expect(await text(part!.body)).toBe('234');
    expect(await (await blobs.blob('projects/p1/notes.json', 'application/json'))!.text()).toBe('{"a":1}');

    // A new write changes the version (caches revalidate on it).
    await blobs.put('projects/p1/notes.json', '{"a":2}');
    expect((await blobs.head('projects/p1/notes.json'))!.version).not.toBe((await blobs.head('projects/p1/bytes.bin'))!.version);

    await blobs.delete('projects/p1/notes.json');
    expect(await blobs.head('projects/p1/notes.json')).toBeUndefined();
    expect(await blobs.get('projects/p1/notes.json')).toBeUndefined();
  });

  it('keeps keys to projects/<id>/… and sounds/<file>', async () => {
    await expect(blobs.put('elsewhere/x', 'no')).rejects.toBeInstanceOf(NotFoundError);
    await expect(blobs.head('projects/../x/y')).rejects.toBeInstanceOf(NotFoundError);
    await expect(blobs.head('projects/p1')).rejects.toBeInstanceOf(NotFoundError);
    await expect(blobs.deletePrefix('projects/')).rejects.toBeInstanceOf(NotFoundError);
    await blobs.put('sounds/move-best.mp3', 'ding');
    expect((await blobs.head('sounds/move-best.mp3'))!.size).toBe(4);
  });

  it('deletes a whole prefix, past one listing page', async () => {
    await Promise.all(Array.from({ length: 1005 }, (_, i) => blobs.put(`projects/p2/thumbs/t${i}.jpg`, 'x')));
    await blobs.put('projects/p20/keep.txt', 'other project');
    await blobs.deletePrefix('projects/p2/');
    expect(await blobs.head('projects/p2/thumbs/t0.jpg')).toBeUndefined();
    expect(await blobs.head('projects/p2/thumbs/t1004.jpg')).toBeUndefined();
    expect(await blobs.head('projects/p20/keep.txt')).toBeDefined();
  }, 60_000);

  it('runs a resumable upload: parts listed for a resume, checked and joined, markers removed', async () => {
    const key = 'projects/p3/source.mp4';
    const uploadId = await blobs.createMultipart(key);
    const part = (n: number, size: number) => new Blob([new Uint8Array(size).fill(n)]).stream() as ReadableStream<Uint8Array>;
    // Parts are uniform but the last (R2's rule; the client uses 8 MiB).
    const e1 = await blobs.uploadPart(key, uploadId, 1, part(1, 5 * MiB));
    expect(await blobs.listParts(key, uploadId)).toEqual([{ partNumber: 1, etag: e1 }]);
    // A resumed client sends part 2 again; the repeat replaces it.
    await blobs.uploadPart(key, uploadId, 2, part(9, 5 * MiB));
    const e2 = await blobs.uploadPart(key, uploadId, 2, part(2, 5 * MiB));
    const e3 = await blobs.uploadPart(key, uploadId, 3, part(3, 1000));
    const listed = await blobs.listParts(key, uploadId);
    expect(listed.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(listed[1]!.etag).toBe(e2);

    await expect(blobs.completeMultipart(key, uploadId, [{ partNumber: 1, etag: e1 }, { partNumber: 3, etag: e3 }])).rejects.toBeInstanceOf(UploadIncompleteError);
    await expect(blobs.completeMultipart(key, uploadId, [{ partNumber: 1, etag: e1 }, { partNumber: 2, etag: e1 }, { partNumber: 3, etag: e3 }])).rejects.toBeInstanceOf(
      UploadIncompleteError,
    );

    await blobs.completeMultipart(key, uploadId, [{ partNumber: 3, etag: `"${e3}"` }, { partNumber: 1, etag: e1 }, { partNumber: 2, etag: e2 }]);
    expect((await blobs.head(key))!.size).toBe(10 * MiB + 1000);
    const middle = await blobs.get(key, { offset: 5 * MiB - 1, length: 2 });
    expect([...new Uint8Array(await new Response(middle!.body).arrayBuffer())]).toEqual([1, 2]);
    const tail = await blobs.get(key, { offset: 10 * MiB, length: 1000 });
    expect(new Uint8Array(await new Response(tail!.body).arrayBuffer()).every((b) => b === 3)).toBe(true);
    // Only the joined file is left under the project.
    const left = await platform.env.MEDIA.list({ prefix: 'projects/p3/' });
    expect(left.objects.map((o) => o.key)).toEqual([key]);
  }, 60_000);

  it('aborts an upload and its markers', async () => {
    const key = 'projects/p4/source.mov';
    const uploadId = await blobs.createMultipart(key);
    await blobs.uploadPart(key, uploadId, 1, new Blob([new Uint8Array(10)]).stream() as ReadableStream<Uint8Array>);
    await blobs.abortMultipart(key, uploadId);
    expect((await platform.env.MEDIA.list({ prefix: 'projects/p4/' })).objects).toEqual([]);
  });
});
