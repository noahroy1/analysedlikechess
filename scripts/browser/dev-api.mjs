// The API as a signed-in user, for checks that call it from Node (the page uses window.__alsFetch).
// Local dev (default): the dev user and Supabase settings that `pnpm dev` writes to
// apps/web/.env.development.local, the editor at localhost:5173 (Vite proxies /api).
// A deployed environment: CHECK_ENV=staging and CHECK_OWNER=<email> (a user who has signed in there
// once). Settings come from wrangler.jsonc and apps/api/.env.<env> (apps/api/scripts/environments.ts);
// the session is minted with the environment's secret key (an admin magic link, verified at once, so
// no email is sent and no password is set). Checks call signIn(page) before opening the editor, and
// open pages under APP_ORIGIN.
import { readFileSync } from 'node:fs';

const CHECK_ENV = process.env.CHECK_ENV;
const deployed = CHECK_ENV ? (await import('../../apps/api/scripts/environments.ts')).loadEnvironment(CHECK_ENV) : undefined;
if (deployed && !process.env.CHECK_OWNER) throw new Error('CHECK_ENV needs CHECK_OWNER=<email>');

/** Where the editor is. */
export const APP_ORIGIN = deployed?.webOrigin ?? 'http://localhost:5173';
/** Where the API is (the editor's origin in dev, through Vite's proxy). */
export const API_ORIGIN = deployed?.apiOrigin ?? APP_ORIGIN;

const ENV_FILE = new URL('../../apps/web/.env.development.local', import.meta.url);
let session;

async function devSession() {
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
  return res.json();
}

async function deployedSession() {
  const { supabaseUrl, secretKey, publishableKey } = deployed;
  const link = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: process.env.CHECK_OWNER }),
  });
  if (!link.ok) throw new Error(`could not make a sign-in link for ${process.env.CHECK_OWNER} (${link.status}): ${await link.text()}`);
  const body = await link.json();
  const tokenHash = body.hashed_token ?? body.properties?.hashed_token;
  const verified = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  if (!verified.ok) throw new Error(`sign-in for ${process.env.CHECK_OWNER} failed (${verified.status}): ${await verified.text()}`);
  return verified.json();
}

async function currentSession() {
  session ??= await (deployed ? deployedSession() : devSession());
  return session;
}

/**
 * Signs the check's browser in as the same user before it opens the editor: on a deployed
 * environment, the session goes where the page's Supabase client keeps it. Dev signs in on its own.
 */
export async function signIn(page) {
  if (!deployed) return;
  const s = await currentSession();
  // Another path than the editor's (any path serves it), so the check's next goto loads the page afresh with the session.
  await page.goto(`${APP_ORIGIN}/check-sign-in`);
  const key = `sb-${deployed.supabaseRef}-auth-token`;
  await page.eval(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(s))}), true`);
}

/** A call to /api/v1 as the signed-in user; POST, PUT and DELETE get an idempotency key. */
export async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${(await currentSession()).access_token}`);
  if (init.method && init.method !== 'GET') headers.set('Idempotency-Key', crypto.randomUUID());
  const res = await fetch(`${API_ORIGIN}/api/v1${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res;
}

/** Downloads a project's file through its signed media URL. */
export async function projectFile(projectId, file) {
  const grant = await (await api(`/projects/${projectId}/media`)).json();
  const res = await fetch(`${API_ORIGIN}${grant.base}${file}?${grant.query}`);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
