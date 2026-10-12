import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = fileURLToPath(new URL('../../../../packages', import.meta.url));

/** The composition's entry point and every package it draws from. */
export const RENDER_ENTRY = join(packages, 'composition/src/render-entry.tsx');
const SOURCE_DIRS = ['composition/src', 'schema/src', 'theme/src'].map((dir) => join(packages, dir));

/**
 * The composition bundled for the renderer. It is bundled once, on first use,
 * and again only when a source file changes (in dev), so a render normally
 * starts at once.
 */
export class EpisodeBundle {
  private current: { fingerprint: string; serveUrl: Promise<string> } | undefined;

  /** The bundle's folder, rebuilt first if the sources changed since it was made. */
  async serveUrl(): Promise<string> {
    const fingerprint = await sourceFingerprint();
    if (this.current?.fingerprint !== fingerprint) {
      const serveUrl = build();
      this.current = { fingerprint, serveUrl };
      // A failed bundle is retried on the next render.
      serveUrl.catch(() => {
        if (this.current?.serveUrl === serveUrl) this.current = undefined;
      });
    }
    return this.current.serveUrl;
  }
}

async function build(): Promise<string> {
  // Webpack is heavy; load it only when something is rendered.
  const { bundle } = await import('@remotion/bundler');
  return bundle({
    entryPoint: RENDER_ENTRY,
    rootDir: join(packages, 'composition'),
    enableCaching: true,
  });
}

/** Paths, sizes and times of every source file, so any edit changes it. */
async function sourceFingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || /\.test\.tsx?$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      const info = await stat(path);
      parts.push(`${path}:${info.size}:${info.mtimeMs}`);
    }
  }
  return parts.sort().join('\n');
}
