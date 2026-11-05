import { createHash } from 'node:crypto';
import type { PortraitRequest } from '@als/schema';

/**
 * Folder-relative file for a crop. Each crop gets its own name, so undoing a
 * new portrait in the editor brings back a file that still exists.
 */
export function portraitFile(request: PortraitRequest): string {
  const slug = request.characterId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'character';
  const key = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 8);
  return `portraits/${slug}-${key}.jpg`;
}
