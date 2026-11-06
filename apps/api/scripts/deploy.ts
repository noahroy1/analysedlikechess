// Deploys one environment (PLAN-CLOUD.md, C4). Every step is safe to repeat.
//   node apps/api/scripts/deploy.ts <staging|production> [step...]
// Steps, in order (all when none are named):
//   db       the migrations in supabase/migrations (through the session pooler);
//   auth     sign-in settings from supabase/config.toml's [remotes.<env>] (needs `supabase login`; email templates
//            only with the environment's own mailer, see authWorkdir());
//   api      the API Worker and its media Containers (`wrangler deploy --env <env>`; needs Docker);
//   secrets  SUPABASE_SECRET_KEY, MEDIA_URL_SECRET and the provider keys in apps/api/.env;
//   sounds   the chess sounds (SOUNDS_DIR, default media/sounds) into the bucket and `app.sounds`;
//   web      the editor built against this environment, deployed as `als-web-<env>` (static files).
// Settings come from wrangler.jsonc and apps/api/.env.<env> (see environments.ts).
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { SOUND_FILE, SoundIdSchema } from '@als/schema';
import { API_DIR, loadEnvironment, readVars, remoteBucket, ROOT, TOOLS_ENV, type Environment } from './environments.ts';

const STEPS = ['db', 'auth', 'api', 'secrets', 'sounds', 'web'] as const;
type Step = (typeof STEPS)[number];
/** Provider keys the Worker takes as secrets (models and other settings use the code's defaults). */
const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY'];

const [name, ...named] = process.argv.slice(2);
if (!name || named.some((s) => !(STEPS as readonly string[]).includes(s))) {
  console.error(`usage: deploy.ts <staging|production> [${STEPS.join('|')}]...`);
  process.exit(2);
}
const env = loadEnvironment(name);
const steps: readonly Step[] = named.length ? (named as Step[]) : STEPS;

const run = (command: string, args: string[], options: { cwd?: string; input?: string; extraEnv?: Record<string, string> } = {}): void =>
  void execFileSync(command, args, { cwd: options.cwd ?? API_DIR, input: options.input, env: { ...TOOLS_ENV, ...options.extraEnv }, stdio: [options.input ? 'pipe' : 'inherit', 'inherit', 'inherit'] });

/**
 * The folder `config push` reads. Supabase refuses email templates on a project that sends through its own
 * default mailer on the Free plan ("Email template modification is not available for free tier projects using
 * the default email provider"), and the push then changes nothing at all. So unless the environment declares
 * its own mailer (`[remotes.<env>.auth.email.smtp]`), it pushes a copy of the config without the template
 * sections: the CLI leaves undeclared settings alone, and the project keeps Supabase's default email, whose
 * link signs in as well as a code would (PKCE, `detectSessionInUrl`; the site URL is the editor).
 */
const authWorkdir = (e: Environment): string => {
  const config = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  if (new RegExp(`^\\[remotes\\.${e.name}\\.auth\\.email\\.smtp\\]`, 'm').test(config)) return ROOT;
  let skipping = false;
  const kept = config.split('\n').filter((line) => {
    if (/^\[/.test(line)) skipping = /^\[auth\.email\.template\./.test(line);
    return !skipping;
  });
  const dir = mkdtempSync(join(tmpdir(), 'als-auth-'));
  mkdirSync(join(dir, 'supabase'));
  writeFileSync(join(dir, 'supabase', 'config.toml'), kept.join('\n'));
  console.log(`(no mailer of its own for ${e.name}: email templates left as they are)`);
  return dir;
};

const actions: Record<Step, (env: Environment) => Promise<void> | void> = {
  db: (e) => run('supabase', ['db', 'push', `--remote=${e.poolerUrl}`, '--yes', '--workdir', ROOT]),
  auth: (e) => {
    const workdir = authWorkdir(e);
    try {
      run('supabase', ['config', 'push', `--remote=${e.supabaseRef}`, '--yes', '--workdir', workdir]);
    } finally {
      if (workdir !== ROOT) rmSync(workdir, { recursive: true, force: true });
    }
  },
  api: (e) => run('wrangler', ['deploy', '--env', e.name]),
  secrets: (e) => {
    const shared = readVars(join(API_DIR, '.env'));
    const secrets: Record<string, string> = { SUPABASE_SECRET_KEY: e.secretKey, MEDIA_URL_SECRET: e.mediaUrlSecret };
    for (const key of PROVIDER_KEYS) {
      const value = shared.get(key);
      if (value) secrets[key] = value;
    }
    console.log(`secrets: ${Object.keys(secrets).join(', ')}`);
    run('wrangler', ['secret', 'bulk', '--env', e.name], { input: JSON.stringify(secrets) });
  },
  sounds: async (e) => {
    const dir = resolve(ROOT, process.env.SOUNDS_DIR ?? 'media/sounds');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => SoundIdSchema.safeParse(SOUND_FILE.exec(f)?.[1]).success).sort() : [];
    if (!files.length) throw new Error(`no sound files in ${dir}`);
    const db = new pg.Client({ connectionString: e.poolerUrl, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const { bucket, dispose } = await remoteBucket(e);
    try {
      const loaded: string[] = [];
      for (const file of files) {
        const [, id, ext] = SOUND_FILE.exec(file)!;
        const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, file)]);
        const durationSec = Number(stdout.trim());
        if (!(durationSec > 0)) continue;
        const body = readFileSync(join(dir, file));
        if ((await bucket.head(`sounds/${file}`))?.size !== body.length) await bucket.put(`sounds/${file}`, body);
        await db.query(
          `insert into app.sounds (id, ext, duration_sec) values ($1, $2, $3)
           on conflict (id) do update set ext = excluded.ext, duration_sec = excluded.duration_sec`,
          [id, ext, durationSec],
        );
        loaded.push(id!);
      }
      await db.query('delete from app.sounds where not (id = any($1::text[]))', [loaded]);
      console.log(`sounds: ${loaded.length} loaded from ${dir}`);
    } finally {
      await dispose();
      await db.end();
    }
  },
  web: (e) => {
    const webDir = join(ROOT, 'apps/web');
    run('pnpm', ['exec', 'vite', 'build'], {
      cwd: webDir,
      extraEnv: {
        VITE_API_ORIGIN: e.apiOrigin,
        VITE_SUPABASE_URL: e.supabaseUrl,
        VITE_SUPABASE_PUBLISHABLE_KEY: e.publishableKey,
        // The browser checks' handles, on staging only.
        VITE_CHECK_HOOKS: e.name === 'staging' ? 'true' : 'false',
      },
    });
    run('wrangler', ['deploy', '--config', join(webDir, 'wrangler.jsonc'), '--env', e.name]);
  },
};

for (const step of steps) {
  console.log(`\n== ${env.name}: ${step}`);
  await actions[step](env);
}
console.log(`\n${env.name}: done (${steps.join(', ')}). Editor ${env.webOrigin}, API ${env.apiOrigin}.`);
