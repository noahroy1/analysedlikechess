// Prepares local dev for the Worker (run by `pnpm dev` after `supabase start`):
// - apps/api/.dev.vars: the Worker's dev secrets (Supabase secret key, a media URL
//   secret kept across runs, provider keys carried over from apps/server/.env,
//   ANALYSIS_REPLAY_DIR when set);
// - apps/web/.env.development.local: Supabase's URL and publishable key, and the dev user;
// - the dev user (an admin with a password, which the web app signs in with on its own);
// - the chess sounds (SOUNDS_DIR, default media/sounds) in local R2 and `app.sounds`.
// Every file it writes is gitignored.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { getPlatformProxy } from 'wrangler';
import { SOUND_FILE, SoundIdSchema } from '@als/schema';
import type { R2Bucket } from '../src/workers.ts';

const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(API_DIR, '../..');
const DEV_VARS = join(API_DIR, '.dev.vars');
const WEB_ENV = join(ROOT, 'apps/web/.env.development.local');
const NODE_ENV_FILE = join(ROOT, 'apps/server/.env');
const DEV_EMAIL = 'dev@als.local';
/** Settings the Node server read from apps/server/.env that the Worker takes too (not the hosted Supabase ones). */
const CARRIED = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|ELEVENLABS_API_KEY|[A-Z]+_MODEL|AUTO_ANALYZE|SCENE_FPS|OPENAI_TIER)$/;

const env = { ...process.env, PATH: [join(API_DIR, 'node_modules/.bin'), process.env.PATH, '/Applications/Docker.app/Contents/Resources/bin'].join(delimiter) };

/** KEY=value lines, without comments (an inline `# note` after a value is dropped, as Node's parser does). */
function readVars(file: string): Map<string, string> {
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

const writeVars = (file: string, vars: Map<string, string>, header: string) =>
  writeFileSync(file, `${header}\n${[...vars].map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });

// Supabase's local URLs and keys.
const status = Object.fromEntries(
  execFileSync('supabase', ['status', '-o', 'env', '--workdir', ROOT], { env, encoding: 'utf8' })
    .split('\n')
    .map((line) => /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!]),
);
const { API_URL: supabaseUrl, SECRET_KEY: secretKey, PUBLISHABLE_KEY: publishableKey, DB_URL: dbUrl } = status;
if (!supabaseUrl || !secretKey || !publishableKey || !dbUrl) throw new Error('supabase status is missing a URL or key: is it running?');

// The Worker's dev secrets.
const vars = readVars(DEV_VARS);
const carried = readVars(NODE_ENV_FILE);
for (const [key, value] of carried) if (CARRIED.test(key) && !vars.has(key)) vars.set(key, value);
vars.set('SUPABASE_SECRET_KEY', secretKey);
if ((vars.get('MEDIA_URL_SECRET') ?? '').length < 32) vars.set('MEDIA_URL_SECRET', randomBytes(32).toString('hex'));
vars.set('DEV_RESUME_JOBS', 'true');
vars.set('DEV_ROUTES', 'true');
// ANALYSIS_REPLAY_DIR on Node named a folder; the Worker replays bundled sets by name.
const replay = process.env.ANALYSIS_REPLAY_DIR;
if (replay) vars.set('ANALYSIS_REPLAY_DIR', basename(resolve(replay, '..')));
else vars.delete('ANALYSIS_REPLAY_DIR');
if (process.env.ANALYSIS_REPLAY_DELAY_MS) vars.set('ANALYSIS_REPLAY_DELAY_MS', process.env.ANALYSIS_REPLAY_DELAY_MS);
else vars.delete('ANALYSIS_REPLAY_DELAY_MS');
writeVars(DEV_VARS, vars, '# Written by apps/api/scripts/dev-setup.ts (pnpm dev). Gitignored: provider keys live here in dev.');

// The dev user: created once, its password kept in the web app's dev env.
const web = readVars(WEB_ENV);
const password = web.get('VITE_DEV_PASSWORD') ?? randomBytes(18).toString('base64url');
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${supabaseUrl}/auth/v1${path}`, { ...init, headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json', ...init.headers } });
const listed = (await (await admin('/admin/users?per_page=1000')).json()) as { users?: { id: string; email?: string }[] };
let userId = listed.users?.find((u) => u.email === DEV_EMAIL)?.id;
if (userId) {
  await admin(`/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify({ password }) });
} else {
  const created = await admin('/admin/users', { method: 'POST', body: JSON.stringify({ email: DEV_EMAIL, password, email_confirm: true }) });
  if (!created.ok) throw new Error(`could not create the dev user: ${created.status} ${await created.text()}`);
  userId = ((await created.json()) as { id: string }).id;
}
web.set('VITE_SUPABASE_URL', supabaseUrl);
web.set('VITE_SUPABASE_PUBLISHABLE_KEY', publishableKey);
web.set('VITE_DEV_EMAIL', DEV_EMAIL);
web.set('VITE_DEV_PASSWORD', password);
writeVars(WEB_ENV, web, '# Written by apps/api/scripts/dev-setup.ts (pnpm dev). Gitignored.');

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query(`update app.profiles set role = 'admin' where user_id = $1`, [userId]);

// The sound bank: each file to local R2 (where `wrangler dev` reads it) and its length to the table.
const soundsDir = resolve(ROOT, process.env.SOUNDS_DIR ?? 'media/sounds');
const files = existsSync(soundsDir) ? readdirSync(soundsDir).filter((f) => SoundIdSchema.safeParse(SOUND_FILE.exec(f)?.[1]).success) : [];
const platform = await getPlatformProxy<{ MEDIA: R2Bucket }>({ configPath: join(API_DIR, 'wrangler.jsonc') });
try {
  const loaded: string[] = [];
  for (const file of files.sort()) {
    const [, id, ext] = SOUND_FILE.exec(file)!;
    const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(soundsDir, file)]);
    const durationSec = Number(stdout.trim());
    if (!(durationSec > 0)) continue;
    await platform.env.MEDIA.put(`sounds/${file}`, readFileSync(join(soundsDir, file)));
    await db.query(
      `insert into app.sounds (id, ext, duration_sec) values ($1, $2, $3)
       on conflict (id) do update set ext = excluded.ext, duration_sec = excluded.duration_sec`,
      [id, ext, durationSec],
    );
    loaded.push(id!);
  }
  // A file taken away leaves the bank too.
  await db.query('delete from app.sounds where not (id = any($1::text[]))', [loaded]);
  console.log(`dev setup: ${DEV_EMAIL} ready; ${loaded.length} sounds loaded from ${soundsDir}`);
} finally {
  await platform.dispose();
  await db.end();
}
