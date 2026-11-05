import type { webcrypto } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { ApiErrorBody } from '@als/schema';
import { scopes } from './db/db.ts';

// Supabase Auth's access tokens, checked in the Worker on every request
// (PLAN-CLOUD.md, "Accounts"): the signature against the project's published
// keys (ES256 since C0, RS256 also accepted), then issuer, audience, role and
// expiry. No library: WebCrypto verifies both algorithms.

export class AuthError extends Error {}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export interface VerifiedUser {
  userId: string;
  email?: string;
  claims: Record<string, unknown>;
}

const ALGORITHMS = {
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' }, kty: 'EC' },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' }, kty: 'RSA' },
} as const;
type Alg = keyof typeof ALGORITHMS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64url(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function json(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64url(segment)));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AuthError('malformed token');
}

export interface TokenVerifierOptions {
  /** The Supabase project URL, e.g. `https://<ref>.supabase.co` or `http://127.0.0.1:54321`. */
  supabaseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long the key set is kept: Supabase's edge caches it 10 minutes, so a new key appears within that (C0). */
  cacheMs?: number;
  /** Tolerance for clock differences on `exp` and `nbf`. */
  leewaySec?: number;
}

/** Checks Supabase access tokens against the project's JWKS, cached and refetched for an unknown key id. */
export class TokenVerifier {
  readonly issuer: string;
  private readonly jwksUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly leewaySec: number;
  private keys: { at: number; byKid: Map<string, { jwk: Jwk; key?: CryptoKey }> } | undefined;
  private loading: Promise<void> | undefined;
  /** An unknown kid refetches at most this often, so junk tokens can't make every request fetch. */
  private lastMissFetch = 0;

  constructor(options: TokenVerifierOptions) {
    const base = options.supabaseUrl.replace(/\/+$/, '');
    this.issuer = `${base}/auth/v1`;
    this.jwksUrl = `${base}/auth/v1/.well-known/jwks.json`;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? 10 * 60_000;
    this.leewaySec = options.leewaySec ?? 30;
  }

  async verify(token: string): Promise<VerifiedUser> {
    const segments = token.split('.');
    if (segments.length !== 3) throw new AuthError('malformed token');
    const [h, p, s] = segments as [string, string, string];
    const header = json(h);
    const alg = header.alg;
    if (alg !== 'ES256' && alg !== 'RS256') throw new AuthError(`unsupported algorithm ${String(alg)}`);
    if (typeof header.kid !== 'string') throw new AuthError('token has no key id');

    const key = await this.key(header.kid, alg);
    const ok = await crypto.subtle.verify(ALGORITHMS[alg].verify, key, base64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new AuthError('bad signature');

    const claims = json(p);
    const nowSec = this.now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + this.leewaySec < nowSec) throw new AuthError('token expired');
    if (typeof claims.nbf === 'number' && claims.nbf - this.leewaySec > nowSec) throw new AuthError('token not yet valid');
    if (claims.iss !== this.issuer) throw new AuthError('wrong issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes('authenticated')) throw new AuthError('wrong audience');
    if (claims.role !== 'authenticated') throw new AuthError('not a signed-in user');
    if (typeof claims.sub !== 'string' || !UUID.test(claims.sub)) throw new AuthError('token has no user');
    return { userId: claims.sub, ...(typeof claims.email === 'string' ? { email: claims.email } : {}), claims };
  }

  private async key(kid: string, alg: Alg): Promise<CryptoKey> {
    if (!this.keys || this.now() - this.keys.at > this.cacheMs) await this.load();
    let entry = this.keys?.byKid.get(kid);
    if (!entry && this.now() - this.lastMissFetch > 30_000) {
      this.lastMissFetch = this.now();
      await this.load();
      entry = this.keys?.byKid.get(kid);
    }
    if (!entry) throw new AuthError('unknown signing key');
    if (entry.jwk.kty !== ALGORITHMS[alg].kty || (entry.jwk.alg && entry.jwk.alg !== alg)) throw new AuthError('key does not match the algorithm');
    entry.key ??= await crypto.subtle.importKey('jwk', entry.jwk as webcrypto.JsonWebKey, ALGORITHMS[alg].import, false, ['verify']);
    return entry.key;
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const res = await this.fetchImpl(this.jwksUrl);
        if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
        const body = (await res.json()) as { keys?: Jwk[] };
        const byKid = new Map<string, { jwk: Jwk }>();
        for (const jwk of body.keys ?? []) if (jwk.kid) byKid.set(jwk.kid, { jwk });
        this.keys = { at: this.now(), byKid };
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }
}

/**
 * Every route but `skip` needs `Authorization: Bearer <access token>`. The user
 * goes into `userId` and the request runs in their database scope.
 * Signed media URLs and the media service's callbacks carry a signature
 * instead (a `<video>` can't send a header), so they are skipped and checked
 * by their own routes.
 */
export function auth(verifier: TokenVerifier, options: { skip?: (path: string, method: string) => boolean } = {}): MiddlewareHandler<{
  Variables: { userId: string };
}> {
  return async (c, next) => {
    if (options.skip?.(c.req.path, c.req.method)) return next();
    const header = c.req.header('Authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    let user: VerifiedUser | undefined;
    if (match) user = await verifier.verify(match[1]!).catch(() => undefined);
    if (!user) {
      const body: ApiErrorBody = { error: match ? 'Your sign-in has expired or is not valid; sign in again.' : 'Sign in first.', code: 'unauthorized' };
      return c.json(body, 401, { 'WWW-Authenticate': 'Bearer' });
    }
    c.set('userId', user.userId);
    await scopes.run({ userId: user.userId }, () => next());
  };
}
