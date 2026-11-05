import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

/**
 * Who a database call acts for. A user's calls run as `authenticated` with
 * their claims, so RLS holds even if a query forgets an owner filter. The
 * service (Workflows, which have no user) runs as the connection's own role and
 * takes the owner from the `jobs` row.
 */
export type Scope = { userId: string } | { service: true };

/**
 * The scope of the work in progress: the auth middleware runs each request in
 * the user's, a Workflow step in the service's. The repos read it, so the
 * services shared with the Node server (analysis, ingest, renders) need no
 * user parameter they don't already have.
 */
export const scopes = new AsyncLocalStorage<Scope>();

export const asUser = <T>(userId: string, work: () => T): T => scopes.run({ userId }, work);
export const asService = <T>(work: () => T): T => scopes.run({ service: true }, work);

/** The scope of the current call. With none, nothing runs: a call that lost its user must fail, not see everything. */
export function currentScope(): Scope {
  const scope = scopes.getStore();
  if (!scope) throw new Error('database call outside a user or service scope');
  return scope;
}

export interface Sql {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Hands out a connection for one transaction. */
export interface Connector {
  connect(): Promise<{ sql: Sql; release(): Promise<void> }>;
}

/** A new client per transaction: what Hyperdrive wants (it pools at the edge; connecting costs 2-7 ms, C0). */
export function clientConnector(connectionString: string): Connector {
  return {
    async connect() {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return { sql: client, release: () => client.end() };
    },
  };
}

/** A pool, for Node (tests and scripts against local Supabase). */
export function poolConnector(pool: pg.Pool): Connector {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        sql: client,
        release: async () => client.release(),
      };
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transactions in a scope. */
export class Db {
  private readonly connector: Connector;

  constructor(connector: Connector) {
    this.connector = connector;
  }

  /**
   * Runs `work` in one transaction. A user's transaction switches to
   * `authenticated` and sets the JWT claims transaction-locally (C0: these
   * don't leak through Hyperdrive's pool).
   */
  async tx<T>(work: (sql: Sql) => Promise<T>, scope: Scope = currentScope()): Promise<T> {
    if ('userId' in scope && !UUID.test(scope.userId)) throw new Error(`not a user id: ${scope.userId}`);
    const { sql, release } = await this.connector.connect();
    try {
      await sql.query('begin');
      if ('userId' in scope) {
        await sql.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: scope.userId, role: 'authenticated' }),
        ]);
      }
      const result = await work(sql);
      await sql.query('commit');
      return result;
    } catch (error) {
      await sql.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await release().catch(() => undefined);
    }
  }
}

/** Postgres error codes the repos act on. */
export const PG = {
  uniqueViolation: '23505',
  rlsViolation: '42501',
} as const;

export const pgCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
