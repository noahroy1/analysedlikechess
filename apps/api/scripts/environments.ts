// Deployed environments (staging, production) as scripts on this Mac see them: deploy.ts, the
// migration, the checks. Names, origins and the bucket come from wrangler.jsonc's `env.<name>`;
// keys from apps/api/.env.<name> (gitignored):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY,
//   SUPABASE_DB_URL     the direct connection (IPv6), which Hyperdrive uses;
//   SUPABASE_POOLER_URL the session pooler (IPv4), for scripts here (this Mac has no IPv6 route);
//   MEDIA_URL_SECRET    signs the environment's media URLs (at least 32 characters).
// Provider keys are shared, in apps/api/.env.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy, unstable_readConfig } from 'wrangler';
import type { R2Bucket } from '../src/workers.ts';

export const API_DIR = fileURLToPath(new URL('..', import.meta.url));
export const ROOT = resolve(API_DIR, '../..');
export const ENVIRONMENTS = ['staging', 'production'] as const;
/** Wrangler, Supabase and Docker on the PATH, as the package scripts have them. */
export const TOOLS_ENV = { ...process.env, PATH: [join(API_DIR, 'node_modules/.bin'), process.env.PATH, '/Applications/Docker.app/Contents/Resources/bin'].join(':') };

/** KEY=value lines, without comments (an inline `# note` after a value is dropped, as Node's parser does). */
export function readVars(file: string): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(file)) return vars;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (value) vars.set(m[1]!, value);
  }
  return vars;
}

export interface Environment {
  name: (typeof ENVIRONMENTS)[number];
  /** The API Worker's name (`als-api-<name>`). */
  worker: string;
  bucket: string;
  apiOrigin: string;
  webOrigin: string;
  supabaseUrl: string;
  /** The Supabase project's ref (its URL's first label). */
  supabaseRef: string;
  publishableKey: string;
  secretKey: string;
  dbUrl: string;
  poolerUrl: string;
  mediaUrlSecret: string;
}

export function loadEnvironment(name: string): Environment {
  if (!(ENVIRONMENTS as readonly string[]).includes(name)) throw new Error(`unknown environment "${name}" (${ENVIRONMENTS.join(', ')})`);
  const config = unstable_readConfig({ config: join(API_DIR, 'wrangler.jsonc'), env: name }, { hideWarnings: true });
  const vars = config.vars as Record<string, string>;
  const file = join(API_DIR, `.env.${name}`);
  const keys = readVars(file);
  const need = (key: string) => {
    const value = keys.get(key);
    if (!value) throw new Error(`${key} is missing from ${file}`);
    return value;
  };
  const supabaseUrl = need('SUPABASE_URL').replace(/\/$/, '');
  if (supabaseUrl !== vars.SUPABASE_URL) throw new Error(`${file}'s SUPABASE_URL is not wrangler.jsonc's env.${name}.vars.SUPABASE_URL`);
  const mediaUrlSecret = need('MEDIA_URL_SECRET');
  if (mediaUrlSecret.length < 32) throw new Error('MEDIA_URL_SECRET must be at least 32 characters');
  return {
    name: name as Environment['name'],
    worker: config.name!,
    bucket: config.r2_buckets[0]!.bucket_name!,
    apiOrigin: vars.API_ORIGIN!,
    webOrigin: vars.WEB_ORIGINS!.split(',')[0]!.trim(),
    supabaseUrl,
    supabaseRef: new URL(supabaseUrl).hostname.split('.')[0]!,
    publishableKey: need('SUPABASE_PUBLISHABLE_KEY'),
    secretKey: need('SUPABASE_SECRET_KEY'),
    dbUrl: need('SUPABASE_DB_URL'),
    poolerUrl: need('SUPABASE_POOLER_URL'),
    mediaUrlSecret,
  };
}

/** The environment's R2 bucket, reached from Node through Wrangler's remote bindings. */
export async function remoteBucket(env: Environment): Promise<{ bucket: R2Bucket; dispose: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'als-r2-'));
  const configPath = join(dir, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({ name: `als-scripts-${env.name}`, compatibility_date: '2026-11-04', r2_buckets: [{ binding: 'MEDIA', bucket_name: env.bucket, remote: true }] }),
  );
  const platform = await getPlatformProxy<{ MEDIA: R2Bucket }>({ configPath, persist: false, envFiles: [] });
  return {
    bucket: platform.env.MEDIA,
    dispose: async () => {
      await platform.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
