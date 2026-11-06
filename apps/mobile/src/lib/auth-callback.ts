// Plain TypeScript (no Capacitor), so it can be tested on Node.

/** What an auth callback URL carries: a PKCE `code`, or an error (in the query or the fragment). */
export function parseAuthCallback(url: string): { code: string } | { error: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.host !== 'auth') return undefined;
  const params = new URLSearchParams(parsed.search);
  for (const [k, v] of new URLSearchParams(parsed.hash.replace(/^#/, ''))) if (!params.has(k)) params.set(k, v);
  const code = params.get('code');
  if (code) return { code };
  const error = params.get('error_description') ?? params.get('error');
  return { error: error ? error.replaceAll('+', ' ') : 'The sign-in link did not work.' };
}
