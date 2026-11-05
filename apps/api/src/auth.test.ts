import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { auth, TokenVerifier } from './auth.ts';
import { currentScope } from './db/db.ts';

const URL_BASE = 'http://127.0.0.1:54321';
const USER = 'c5f098a5-02f5-4b07-a6a5-82c761880b93';

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'ES256', use: 'sig' };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const h = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid, ...header }));
    const p = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`)));
    return `${h}.${p}.${b64url(sig)}`;
  };
  return { jwk, sign };
}

/** Claims as Supabase Auth issues them (seen on the local stack, Nov 5). */
const claims = (over: Record<string, unknown> = {}) => ({
  iss: `${URL_BASE}/auth/v1`,
  sub: USER,
  aud: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  role: 'authenticated',
  email: 'a@example.test',
  ...over,
});

function setup(keys: object[]) {
  const served = { keys, fetches: 0 };
  const verifier = new TokenVerifier({
    supabaseUrl: URL_BASE,
    fetch: async () => {
      served.fetches++;
      return Response.json({ keys: served.keys });
    },
  });
  return { verifier, served };
}

describe('TokenVerifier', () => {
  it('accepts a signed-in user and caches the key set', async () => {
    const k = await keyPair('k1');
    const { verifier, served } = setup([k.jwk]);
    const user = await verifier.verify(await k.sign(claims()));
    expect(user.userId).toBe(USER);
    expect(user.email).toBe('a@example.test');
    await verifier.verify(await k.sign(claims()));
    expect(served.fetches).toBe(1);
  });

  it('refuses tokens that are expired, misissued, for another audience or role, or tampered with', async () => {
    const k = await keyPair('k1');
    const { verifier } = setup([k.jwk]);
    const now = Math.floor(Date.now() / 1000);
    await expect(verifier.verify(await k.sign(claims({ exp: now - 120 })))).rejects.toThrow('expired');
    await expect(verifier.verify(await k.sign(claims({ iss: 'https://other.supabase.co/auth/v1' })))).rejects.toThrow('issuer');
    await expect(verifier.verify(await k.sign(claims({ aud: 'anon' })))).rejects.toThrow('audience');
    // The project's publishable and secret keys are JWTs too, with role anon or service_role.
    await expect(verifier.verify(await k.sign(claims({ role: 'service_role' })))).rejects.toThrow('signed-in');
    await expect(verifier.verify(await k.sign(claims({ sub: 'local' })))).rejects.toThrow('user');
    const good = await k.sign(claims());
    const [h, , s] = good.split('.');
    const forged = `${h}.${b64url(JSON.stringify(claims({ sub: '00000000-0000-4000-8000-000000000000' })))}.${s}`;
    await expect(verifier.verify(forged)).rejects.toThrow('signature');
    await expect(verifier.verify(await k.sign(claims(), { alg: 'HS256' }))).rejects.toThrow('algorithm');
    await expect(verifier.verify('not.a.token')).rejects.toThrow();
  });

  it('refetches the key set for an unknown key id (a rotation) and refuses keys it never publishes', async () => {
    const k1 = await keyPair('k1');
    const k2 = await keyPair('k2');
    const { verifier, served } = setup([k1.jwk]);
    await verifier.verify(await k1.sign(claims()));
    served.keys = [k1.jwk, k2.jwk];
    expect((await verifier.verify(await k2.sign(claims()))).userId).toBe(USER);
    expect(served.fetches).toBe(2);
    // Another unknown kid within 30 s of that refetch doesn't fetch again, so junk tokens can't hammer the endpoint.
    const stranger = await keyPair('k3');
    await expect(verifier.verify(await stranger.sign(claims()))).rejects.toThrow('unknown signing key');
    expect(served.fetches).toBe(2);
  });
});

describe('auth middleware', () => {
  it('answers 401 unauthorized without a valid token, and runs the request in the user scope with one', async () => {
    const k = await keyPair('k1');
    const { verifier } = setup([k.jwk]);
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use(auth(verifier, { skip: (path) => path.startsWith('/media/') }));
    app.get('/me', async (c) => {
      await Promise.resolve();
      return c.json({ userId: c.get('userId'), scope: currentScope() });
    });
    app.get('/media/x', (c) => c.text('signed elsewhere'));

    const none = await app.request('/me');
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: 'unauthorized' });
    expect((await app.request('/me', { headers: { Authorization: 'Bearer junk' } })).status).toBe(401);

    const ok = await app.request('/me', { headers: { Authorization: `Bearer ${await k.sign(claims())}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId: USER, scope: { userId: USER } });

    expect((await app.request('/media/x')).status).toBe(200);
  });
});
