import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { UploadedPart } from '@als/schema';
import { NotFoundError, UploadIncompleteError, type BlobBody, type BlobHead, type BlobRange, type BlobStore } from '../ports.ts';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UPLOAD_ID = /^[a-f0-9]{24}$/;

/**
 * Blobs as files: `projects/<id>/<file>` under the projects folder and
 * `sounds/<file>` under the sounds folder, the layout the app has always used.
 */
export class FsBlobStore implements BlobStore {
  readonly projectsDir: string;
  readonly soundsDir: string;

  constructor(dirs: { projectsDir: string; soundsDir: string }) {
    this.projectsDir = dirs.projectsDir;
    this.soundsDir = dirs.soundsDir;
  }

  /** The file behind a key. Keys never climb out of their folder. */
  path(key: string): string {
    const parts = key.split('/');
    if (!parts.every((p) => SAFE_SEGMENT.test(p))) throw new NotFoundError(`no blob ${key}`);
    const [root, ...rest] = parts;
    if (root === 'projects' && rest.length >= 2) return join(this.projectsDir, ...rest);
    if (root === 'sounds' && rest.length === 1) return join(this.soundsDir, rest[0]!);
    throw new NotFoundError(`no blob ${key}`);
  }

  async head(key: string): Promise<BlobHead | undefined> {
    const info = await stat(this.path(key)).catch(() => undefined);
    return info?.isFile() ? { size: info.size, version: String(info.mtimeMs) } : undefined;
  }

  async get(key: string, range?: BlobRange): Promise<BlobBody | undefined> {
    const head = await this.head(key);
    if (!head) return undefined;
    const options = range && range.length > 0 ? { start: range.offset, end: range.offset + range.length - 1 } : {};
    const body = Readable.toWeb(createReadStream(this.path(key), options)) as ReadableStream<Uint8Array>;
    return { ...head, body, ...(range ? { range } : {}) };
  }

  async blob(key: string, type?: string): Promise<Blob | undefined> {
    if (!(await this.head(key))) return undefined;
    return openAsBlob(this.path(key), type ? { type } : {});
  }

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array | string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    if (typeof body === 'string' || body instanceof Uint8Array) await writeFile(tmp, body);
    else await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), createWriteStream(tmp));
    await rename(tmp, path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (!prefix.endsWith('/')) throw new Error('a prefix ends in /');
    const parts = prefix.slice(0, -1).split('/');
    if (!parts.every((p) => SAFE_SEGMENT.test(p)) || parts.length < 2) throw new NotFoundError(`no prefix ${prefix}`);
    const [root, ...rest] = parts;
    const dir = root === 'projects' ? join(this.projectsDir, ...rest) : root === 'sounds' ? this.soundsDir : undefined;
    if (!dir) throw new NotFoundError(`no prefix ${prefix}`);
    await rm(dir, { recursive: true, force: true });
  }

  // Multipart: parts are files beside the target until they are joined.

  private partsDir(key: string, uploadId: string): string {
    if (!UPLOAD_ID.test(uploadId)) throw new NotFoundError('upload not found');
    return `${this.path(key)}.upload-${uploadId}`;
  }

  async createMultipart(key: string): Promise<string> {
    const uploadId = randomBytes(12).toString('hex');
    await mkdir(this.partsDir(key, uploadId), { recursive: true });
    return uploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: ReadableStream<Uint8Array>): Promise<string> {
    const dir = this.partsDir(key, uploadId);
    if (!(await stat(dir).catch(() => undefined))) throw new NotFoundError('upload not found');
    const md5 = createHash('md5');
    const tmp = join(dir, `${partName(partNumber)}.${randomBytes(4).toString('hex')}.tmp`);
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        md5.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), hashing, createWriteStream(tmp));
    const etag = md5.digest('hex');
    await rename(tmp, join(dir, partName(partNumber)));
    await writeFile(join(dir, `${partName(partNumber)}.etag`), etag);
    return etag;
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const dir = this.partsDir(key, uploadId);
    const files = await readdir(dir).catch(() => {
      throw new NotFoundError('upload not found');
    });
    const parts = await Promise.all(
      files
        .filter((f) => /^part-\d{5}\.etag$/.test(f))
        .map(async (f) => ({ partNumber: Number(f.slice(5, 10)), etag: (await readFile(join(dir, f), 'utf8')).trim() })),
    );
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    const dir = this.partsDir(key, uploadId);
    const stored = new Map((await this.listParts(key, uploadId)).map((p) => [p.partNumber, p.etag]));
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    ordered.forEach((p, i) => {
      if (p.partNumber !== i + 1) throw new UploadIncompleteError(`part ${i + 1} is missing`);
      if (stored.get(p.partNumber) !== p.etag.replaceAll('"', '')) throw new UploadIncompleteError(`part ${p.partNumber} does not match what was uploaded`);
    });
    const path = this.path(key);
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    const out = createWriteStream(tmp);
    try {
      for (const p of ordered) await pipeline(createReadStream(join(dir, partName(p.partNumber))), out, { end: false });
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    } catch (error) {
      out.destroy();
      await rm(tmp, { force: true });
      throw error;
    }
    await rename(tmp, path);
    await rm(dir, { recursive: true, force: true });
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await rm(this.partsDir(key, uploadId), { recursive: true, force: true });
  }
}

const partName = (n: number) => `part-${String(n).padStart(5, '0')}`;
