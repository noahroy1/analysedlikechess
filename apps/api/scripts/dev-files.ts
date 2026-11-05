// Moves dev files between the Worker's local R2 (keys under dev/) and a folder, through the
// running `pnpm dev` as the dev user (DEV_ROUTES).
//   node apps/api/scripts/dev-files.ts pull <r2 prefix> <dir>   e.g. pull dev/handoff/bb1 /tmp/handoff
//   node apps/api/scripts/dev-files.ts push <dir> <r2 prefix>   uploads every .json file in <dir>
//   node apps/api/scripts/dev-files.ts list [<r2 prefix>]
// Recordings (ANALYSIS_RECORD_DIR=<name>) are under dev/record/<name>/, hand-offs
// (ANALYST_HANDOFF_DIR=<name>) under dev/handoff/<name>/.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PREFIX } from '@als/schema';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:8790';
const env = Object.fromEntries(
  readFileSync(join(ROOT, 'apps/web/.env.development.local'), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!]),
);

async function token(): Promise<string> {
  const res = await fetch(`${env.VITE_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.VITE_DEV_EMAIL, password: env.VITE_DEV_PASSWORD }),
  });
  if (!res.ok) throw new Error(`dev sign-in failed (${res.status}): is \`pnpm dev\` running?`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const auth = { Authorization: `Bearer ${await token()}` };
const call = async (method: string, path: string, body?: string) => {
  const res = await fetch(`${ORIGIN}${API_PREFIX}${path}`, {
    method,
    headers: { ...auth, ...(method === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res;
};
const slash = (prefix: string) => (prefix.endsWith('/') ? prefix : `${prefix}/`);
const list = async (prefix: string) => ((await (await call('GET', `/dev/files?prefix=${encodeURIComponent(prefix)}`)).json()) as { keys: string[] }).keys;
const filePath = (key: string) => `/dev/files/${key.split('/').map(encodeURIComponent).join('/')}`;

const [command, a, b] = process.argv.slice(2);
if (command === 'list') {
  for (const key of await list(a ?? 'dev/')) console.log(key);
} else if (command === 'pull' && a && b) {
  const prefix = slash(a);
  mkdirSync(b, { recursive: true });
  const keys = (await list(prefix)).filter((key) => !key.slice(prefix.length).includes('/'));
  for (const key of keys) writeFileSync(join(b, key.slice(prefix.length)), await (await call('GET', filePath(key))).text());
  console.log(`pulled ${keys.length} files from ${prefix} to ${b}`);
} else if (command === 'push' && a && b) {
  const prefix = slash(b);
  const files = readdirSync(a).filter((f) => f.endsWith('.json'));
  for (const file of files) await call('PUT', filePath(prefix + basename(file)), readFileSync(join(a, file), 'utf8'));
  console.log(`pushed ${files.length} files from ${a} to ${prefix}`);
} else {
  console.error('usage: dev-files.ts pull <r2 prefix> <dir> | push <dir> <r2 prefix> | list [<r2 prefix>]');
  process.exitCode = 2;
}
