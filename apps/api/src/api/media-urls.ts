import { API_PREFIX, MEDIA_URL_TTL_SEC, type MediaGrant } from '@als/schema';

// Signed media URLs. A <video> or <audio> element can't send an Authorization
// header, so every media URL the API hands out carries `u`, `exp` and `sig`:
// an HMAC over a scope (a project's files, the sound bank, one upload part),
// the user and the expiry. URLs are relative to the API's origin.

const encoder = new TextEncoder();

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

export const projectScope = (projectId: string) => `projects/${projectId}/`;
export const SOUNDS_SCOPE = 'sounds/';
export const uploadPartScope = (projectId: string, uploadId: string, partNumber: number) => `upload/${projectId}/${uploadId}/${partNumber}`;

// The media service's own URLs: one file to read, one file to write, one task's
// callback. They stand in for presigned R2 URLs and the Worker's callback route.
export const mediaInScope = (projectId: string, file: string) => `media-in/${projectId}/${file}`;
export const mediaOutScope = (projectId: string, file: string) => `media-out/${projectId}/${file}`;
export const mediaTaskScope = (taskId: string) => `media-task/${taskId}`;
/** The principal media URLs are signed for (no user is involved). */
export const MEDIA_PRINCIPAL = 'media';

export class MediaSigner {
  private readonly key: Promise<CryptoKey>;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('the media URL secret must be at least 32 characters');
    this.key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  /** `u=…&exp=…&sig=…` for a scope, valid for `ttlSec`. */
  async sign(scope: string, userId: string, ttlSec = MEDIA_URL_TTL_SEC, nowMs = Date.now()): Promise<{ query: string; expiresAt: string }> {
    const exp = Math.floor(nowMs / 1000) + ttlSec;
    const sig = base64url(await crypto.subtle.sign('HMAC', await this.key, encoder.encode(`${scope}\n${userId}\n${exp}`)));
    return { query: new URLSearchParams({ u: userId, exp: String(exp), sig }).toString(), expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** The user a signature was made for, or undefined when it is missing, wrong or expired. */
  async verify(scope: string, params: URLSearchParams, nowMs = Date.now()): Promise<string | undefined> {
    const userId = params.get('u');
    const exp = Number(params.get('exp'));
    const sig = params.get('sig');
    if (!userId || !sig || !Number.isInteger(exp) || exp * 1000 < nowMs) return undefined;
    const expected = base64url(await crypto.subtle.sign('HMAC', await this.key, encoder.encode(`${scope}\n${userId}\n${exp}`)));
    return timingSafeEqual(sig, expected) ? userId : undefined;
  }

  /** One signature for every file of a project. */
  async grant(userId: string, projectId: string, ttlSec = MEDIA_URL_TTL_SEC): Promise<MediaGrant> {
    const { query, expiresAt } = await this.sign(projectScope(projectId), userId, ttlSec);
    return { base: `${API_PREFIX}/projects/${projectId}/files/`, query, expiresAt };
  }

  /** One signature for the shared sound bank. */
  async soundsGrant(userId: string, ttlSec = MEDIA_URL_TTL_SEC): Promise<MediaGrant> {
    const { query, expiresAt } = await this.sign(SOUNDS_SCOPE, userId, ttlSec);
    return { base: `${API_PREFIX}/sounds/`, query, expiresAt };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
