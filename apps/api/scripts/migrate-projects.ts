// C4's migration: the Node server's project folders (projects/<id>/) into Postgres and R2, owned by
// one user. The folders are only read; a repeat copies again (files already in R2 at the same size
// are skipped).
//   node apps/api/scripts/migrate-projects.ts [--env <staging|production>] [--owner <email>] [--from <projects dir>] <id>... | --all
// Without --env: local Supabase and the Worker's local R2; the owner defaults to the dev user
// (dev@als.local). Stop `pnpm dev` first: its Worker uses the same local R2 files.
// With --env: that environment's database (through the session pooler) and R2 bucket (through
// Wrangler's remote bindings), settings from apps/api/.env.<env>; --owner is required and must
// have signed in to that environment's editor once.
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { getPlatformProxy } from 'wrangler';
import { asUser, Db, poolConnector } from '../src/db/db.ts';
import { PgProjectRepo } from '../src/db/project-repo.ts';
import { FsProjectRepo } from '../src/node/fs-repo.ts';
import { migrateProject } from '../src/node/migrate.ts';
import { R2BlobStore } from '../src/r2-blobs.ts';
import type { R2Bucket } from '../src/workers.ts';
import { API_DIR, loadEnvironment, remoteBucket, ROOT, TOOLS_ENV } from './environments.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const envName = option('--env');
const deployed = envName ? loadEnvironment(envName) : undefined;
const owner = option('--owner') ?? (deployed ? undefined : 'dev@als.local');
if (!owner) throw new Error('--owner <email> is required with --env');
const from = resolve(option('--from') ?? join(ROOT, 'projects'));
const all = args.includes('--all');
const source = new FsProjectRepo(from);
const ids = all ? (await source.list()).map((p) => p.id) : args;
if (!ids.length) {
  console.error('usage: migrate-projects.ts [--env <staging|production>] [--owner <email>] [--from <projects dir>] <id>... | --all');
  process.exit(2);
}

/** Where the projects go: the environment's, or local dev's. */
async function openTarget(): Promise<{ pool: pg.Pool; bucket: R2Bucket; dispose: () => Promise<void> }> {
  if (deployed) {
    const pool = new pg.Pool({ connectionString: deployed.poolerUrl, max: 4, ssl: { rejectUnauthorized: false } });
    const { bucket, dispose } = await remoteBucket(deployed);
    console.log(`target: ${deployed.name} (${deployed.supabaseUrl}, R2 ${deployed.bucket})`);
    return { pool, bucket, dispose };
  }
  const workerUp = await new Promise<boolean>((done) => {
    const socket = connect(8790, '127.0.0.1', () => done(true)).on('error', () => done(false));
    socket.unref();
  });
  if (workerUp) throw new Error('Stop `pnpm dev` first: its Worker uses the same local R2 files (port 8790 is in use).');

  const status = Object.fromEntries(
    execFileSync('supabase', ['status', '-o', 'env', '--workdir', ROOT], {
      encoding: 'utf8',
      env: TOOLS_ENV,
    })
      .split('\n')
      .map((line) => /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
  if (!status.DB_URL) throw new Error('local Supabase is not running (pnpm --filter @als/api db:start)');

  const pool = new pg.Pool({ connectionString: status.DB_URL, max: 4 });
  // wrangler dev's local state is under apps/api; without a path the proxy would use the working directory's .wrangler.
  const platform = await getPlatformProxy<{ MEDIA: R2Bucket }>({ configPath: join(API_DIR, 'wrangler.jsonc'), persist: { path: join(API_DIR, '.wrangler/state/v3') } });
  return { pool, bucket: platform.env.MEDIA, dispose: () => platform.dispose() };
}

const { pool, bucket, dispose } = await openTarget();
try {
  const { rows } = await pool.query<{ id: string }>('select id from auth.users where lower(email) = lower($1)', [owner]);
  if (!rows[0]) throw new Error(deployed ? `no user ${owner} in ${deployed.name}: sign in to ${deployed.webOrigin} once first` : `no user ${owner} in local Supabase (pnpm dev creates the dev user)`);
  const db = new Db(poolConnector(pool));
  const target = { db, repo: new PgProjectRepo(db), blobs: new R2BlobStore(bucket) };
  for (const id of ids) {
    const started = Date.now();
    console.log(`${id}:`);
    const r = await asUser(rows[0].id, () => migrateProject(source, id, target, console.log));
    console.log(
      `  ${r.versions} versions, ${r.stages} stage outputs, ${r.renders} renders, ${r.files} files (${Math.round(r.bytes / 1024 / 1024)} MB; ${r.skippedFiles} already there) in ${Math.round((Date.now() - started) / 1000)} s`,
    );
  }
} finally {
  await dispose();
  await pool.end();
}
