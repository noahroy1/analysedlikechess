// The API as the dev user, for checks that call it from Node (the page uses window.__alsFetch).
// Reads the dev user and Supabase settings that `pnpm dev` writes to apps/web/.env.development.local.
import { readFileSync } from 'node:fs';

const ENV_FILE = new URL('../../apps/web/.env.development.local', import.meta.url);
const ORIGIN = 'http://localhost:5173';
let token;

async function devToken() {
  if (token) return token;
  const env = Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .map((line) => /^([A-Z_]+)=(.*)$/.exec(line))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const res = await fetch(`${env.VITE_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.VITE_DEV_EMAIL, password: env.VITE_DEV_PASSWORD }),
  });
  if (!res.ok) throw new Error(`dev sign-in failed (${res.status}): is \`pnpm dev\` running?`);
  token = (await res.json()).access_token;
  return token;
}

/** A call to /api/v1 as the dev user; POST, PUT and DELETE get an idempotency key. */
export async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await devToken()}`);
  if (init.method && init.method !== 'GET') headers.set('Idempotency-Key', crypto.randomUUID());
  const res = await fetch(`${ORIGIN}/api/v1${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res;
}

/** Downloads a project's file through its signed media URL. */
export async function projectFile(projectId, file) {
  const grant = await (await api(`/projects/${projectId}/media`)).json();
  const res = await fetch(`${ORIGIN}${grant.base}${file}?${grant.query}`);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
