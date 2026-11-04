import { Client } from 'pg';

interface Env { HYPERDRIVE: Hyperdrive }

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const claims = (sub: string) => JSON.stringify({ sub, role: 'authenticated' });

const SETUP = `
create schema if not exists spike;
create table if not exists spike.docs (id text primary key, owner uuid not null, version int not null, doc jsonb not null);
create table if not exists spike.versions (doc_id text not null, version int not null, doc jsonb not null, primary key (doc_id, version));
alter table spike.docs enable row level security;
alter table spike.versions enable row level security;
drop policy if exists own on spike.docs;
create policy own on spike.docs for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists own on spike.versions;
create policy own on spike.versions for all to authenticated
  using (exists (select 1 from spike.docs d where d.id = doc_id and d.owner = auth.uid()))
  with check (exists (select 1 from spike.docs d where d.id = doc_id and d.owner = auth.uid()));
grant usage on schema spike to authenticated;
grant select, insert, update, delete on spike.docs, spike.versions to authenticated;
insert into spike.docs values ('doc-a', '${A}', 1, '{"moments":[]}'), ('doc-b', '${B}', 1, '{"moments":[]}') on conflict do nothing;
`;

// A doc about BB1's size (7 moments with text), so the payload is realistic.
const DOC = JSON.stringify({ moments: Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, label: 'Tread Lightly', explanation: 'x'.repeat(170), at: i * 20 })) , pad: 'y'.repeat(20000) });

async function asUser<T>(c: Client, sub: string, body: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [claims(sub)]);
    const out = await body();
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const t0 = performance.now();
    const c = new Client({ connectionString: env.HYPERDRIVE.connectionString });
    await c.connect();
    const tConnect = performance.now() - t0;
    try {
      if (url.pathname === '/setup') { await c.query(SETUP); return Response.json({ ok: true }); }
      if (url.pathname === '/teardown') { await c.query('drop schema spike cascade'); return Response.json({ ok: true }); }

      if (url.pathname === '/save') {
        // The real save: version-checked update, a history row, trim to 20, in one transaction with the user's claims.
        const t1 = performance.now();
        const version = await asUser(c, A, async () => {
          const cur = await c.query('select version from spike.docs where id = $1', ['doc-a']);
          const v = cur.rows[0].version as number;
          const up = await c.query('update spike.docs set doc = $1, version = version + 1 where id = $2 and version = $3 returning version', [DOC, 'doc-a', v]);
          if (!up.rowCount) throw new Error('409');
          const nv = up.rows[0].version as number;
          await c.query('insert into spike.versions values ($1, $2, $3)', ['doc-a', nv, DOC]);
          await c.query('delete from spike.versions where doc_id = $1 and version <= $2', ['doc-a', nv - 20]);
          return nv;
        });
        return Response.json({ version, connectMs: tConnect, txMs: performance.now() - t1 });
      }

      if (url.pathname === '/save1') {
        // The same save as one statement (one round trip inside the transaction).
        const t1 = performance.now();
        const version = await asUser(c, A, async () => {
          const r = await c.query(`
            with up as (update spike.docs set doc = $1, version = version + 1 where id = $2 returning version),
                 ins as (insert into spike.versions select $2, version, $1::jsonb from up returning version)
            delete from spike.versions where doc_id = $2 and version <= (select version - 20 from ins) returning (select version from ins)`, [DOC, 'doc-a']);
          return r.rows[0]?.version;
        });
        return Response.json({ version, connectMs: tConnect, txMs: performance.now() - t1 });
      }

      if (url.pathname === '/isolation') {
        // RLS through Hyperdrive: A sees only A's doc and cannot touch B's; the claims do not leak past the transaction.
        const seenByA = await asUser(c, A, async () => (await c.query('select id from spike.docs order by id')).rows.map((r) => r.id));
        const bUpdatedByA = await asUser(c, A, async () => (await c.query("update spike.docs set version = version where id = 'doc-b'")).rowCount);
        const seenByB = await asUser(c, B, async () => (await c.query('select id from spike.docs order by id')).rows.map((r) => r.id));
        const after = (await c.query("select current_user as role, coalesce(current_setting('request.jwt.claims', true), '') as claims")).rows[0];
        // A second, fresh client: Hyperdrive may hand it the pooled connection the transactions used.
        const c2 = new Client({ connectionString: env.HYPERDRIVE.connectionString });
        await c2.connect();
        const fresh = (await c2.query("select current_user as role, coalesce(current_setting('request.jwt.claims', true), '') as claims")).rows[0];
        await c2.end();
        return Response.json({ seenByA, bUpdatedByA, seenByB, afterTx: after, freshClient: fresh });
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    } finally {
      await c.end();
    }
  },
};
