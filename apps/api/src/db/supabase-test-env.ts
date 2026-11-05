import { readFileSync } from 'node:fs';
import pg from 'pg';
import { ProjectSchema, type Project } from '@als/schema';
import { Db, poolConnector } from './db.ts';

// The database tests run against local Supabase (`pnpm --filter @als/api test:db`,
// which sets these from `supabase status`); `pnpm check` skips them, as the plan
// keeps Docker out of it.

export const env = {
  dbUrl: process.env.SUPABASE_DB_URL,
  url: process.env.SUPABASE_URL,
  secretKey: process.env.SUPABASE_SECRET_KEY,
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
};
export const haveSupabase = Boolean(env.dbUrl && env.url && env.secretKey && env.publishableKey);

export function connect() {
  const pool = new pg.Pool({ connectionString: env.dbUrl, max: 8 });
  return { pool, db: new Db(poolConnector(pool)) };
}

export interface TestUser {
  id: string;
  email: string;
  /** A real access token from local Supabase Auth. */
  token: string;
}

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${env.url}/auth/v1${path}`, {
    ...init,
    headers: { apikey: env.secretKey!, Authorization: `Bearer ${env.secretKey}`, 'Content-Type': 'application/json', ...init.headers },
  });

/** A confirmed user with a password, signed in. Removed with `removeUser` (its data goes with it, by cascade). */
export async function createUser(label: string): Promise<TestUser> {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const created = await admin('/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
  if (!created.ok) throw new Error(`create user: ${created.status} ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  const session = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.publishableKey!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!session.ok) throw new Error(`sign in: ${session.status} ${await session.text()}`);
  const { access_token } = (await session.json()) as { access_token: string };
  return { id, email, token: access_token };
}

export async function removeUser(user: TestUser | undefined) {
  if (user) await admin(`/admin/users/${user.id}`, { method: 'DELETE' });
}

const SAMPLE = ProjectSchema.parse(JSON.parse(readFileSync(new URL('../../../../fixtures/sample/project.json', import.meta.url), 'utf8')));

/** The sample project under a new id. */
export function sampleProject(id: string): Project {
  return { ...structuredClone(SAMPLE), id, version: 1, createdAt: new Date().toISOString() };
}
