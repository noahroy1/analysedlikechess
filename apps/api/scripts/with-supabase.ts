// Runs a command with the local Supabase stack's URLs and keys in its environment
// (`supabase status`), e.g. the database tests: `pnpm test:db`.
import { execFileSync, spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCKER_BIN = '/Applications/Docker.app/Contents/Resources/bin';
const LOCAL_BIN = fileURLToPath(new URL('../node_modules/.bin', import.meta.url));
const env = { ...process.env, PATH: [LOCAL_BIN, process.env.PATH, DOCKER_BIN].join(delimiter) };

let status: string;
try {
  status = execFileSync('supabase', ['status', '-o', 'env', '--workdir', '../..'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  console.error('Local Supabase is not running: start it with `pnpm --filter @als/api db:start`.');
  process.exit(1);
}
const values = Object.fromEntries(
  status
    .split('\n')
    .map((line) => /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2]]),
);
for (const name of ['DB_URL', 'API_URL', 'SECRET_KEY', 'PUBLISHABLE_KEY']) {
  if (!values[name]) throw new Error(`supabase status gave no ${name}`);
}
Object.assign(env, {
  SUPABASE_DB_URL: values.DB_URL,
  SUPABASE_URL: values.API_URL,
  SUPABASE_SECRET_KEY: values.SECRET_KEY,
  SUPABASE_PUBLISHABLE_KEY: values.PUBLISHABLE_KEY,
});
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('usage: with-supabase.ts <command> [args…]');
const run = spawnSync(command, args, { env, stdio: 'inherit' });
process.exit(run.status ?? 1);
