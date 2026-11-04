import type { BlobRange } from '../ports.ts';

/**
 * A single `Range: bytes=…` request against an object of `size` bytes:
 * undefined for the whole object, 'unsatisfiable' for a range outside it.
 * Multiple ranges are answered with the whole object, which HTTP allows.
 */
export function parseRange(header: string | undefined, size: number): BlobRange | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, from, to] = match;
  if (from === '' && to === '') return undefined;
  let start: number;
  let end: number;
  if (from === '') {
    // The last `to` bytes.
    const suffix = Number(to);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  json: 'application/json',
};

export const contentType = (file: string) => TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
