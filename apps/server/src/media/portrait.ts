import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PortraitRequest, Source } from '@als/schema';
import { run } from './run.ts';

/** Portraits are stored square at this size; the bar draws them at 76 px on a 1080p frame. */
export const PORTRAIT_PX = 256;

/** The crop in source pixels: a square kept inside the frame. */
export function portraitCrop(request: Pick<PortraitRequest, 'x' | 'y' | 'size'>, source: Pick<Source, 'width' | 'height'>) {
  const side = Math.max(16, Math.min(Math.round(request.size * source.height), source.width, source.height));
  const x = Math.min(Math.max(Math.round(request.x * source.width), 0), source.width - side);
  const y = Math.min(Math.max(Math.round(request.y * source.height), 0), source.height - side);
  return { side, x, y };
}

/**
 * Folder-relative file for a crop. Each crop gets its own name, so undoing a
 * new portrait in the editor brings back a file that still exists.
 */
export function portraitFile(request: PortraitRequest): string {
  const slug = request.characterId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'character';
  const key = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 8);
  return `portraits/${slug}-${key}.jpg`;
}

/** Crops one frame of the source into a square JPEG. */
export async function extractPortrait(sourcePath: string, outPath: string, request: PortraitRequest, source: Pick<Source, 'width' | 'height' | 'durationSec'>) {
  const { side, x, y } = portraitCrop(request, source);
  const at = Math.min(Math.max(request.sourceTime, 0), Math.max(0, source.durationSec - 0.05));
  await mkdir(dirname(outPath), { recursive: true });
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    at.toFixed(3),
    '-i',
    sourcePath,
    '-frames:v',
    '1',
    '-vf',
    `crop=${side}:${side}:${x}:${y},scale=${PORTRAIT_PX}:${PORTRAIT_PX}:flags=lanczos`,
    '-q:v',
    '3',
    outPath,
  ]);
}
