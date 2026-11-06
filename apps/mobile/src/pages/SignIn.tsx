import type { OAuthProvider } from '@als/client';
import { Browser } from '@capacitor/browser';
import { useEffect, useState } from 'react';
import { AUTH_REDIRECT, config } from '../lib/config.ts';
import { onSignInError } from '../lib/links.ts';
import { session } from '../lib/session.ts';

const PROVIDER_NAMES: Record<OAuthProvider, string> = { google: 'Google', apple: 'Apple' };

/**
 * Sign-in: an email whose link opens this app (and, where the project sends its own template, a 6-digit
 * code), or Google and Apple once their credentials are set (PLAN-CLOUD.md decision 8; Apple waits for
 * the paid Apple Developer account).
 */
export function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProvider[]>([]);

  useEffect(() => {
    void session.providers().then((on) => setProviders((['google', 'apple'] as const).filter((p) => on[p])), () => undefined);
    return onSignInError((message) => {
      setBusy(false);
      setError(message);
    });
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    run(async () => {
      await session.sendCode(email.trim(), AUTH_REDIRECT);
      setSent(true);
    });

  return (
    <div className="flex min-h-full flex-col justify-center px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Analysed Like Chess</h1>
      <p className="mt-1 text-sm text-neutral-400">Sign in to review your scenes.</p>
      {!sent ? (
        <form
          className="mt-8 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field text-base"
          />
          <button type="submit" disabled={busy || !email.includes('@')} className="btn-primary">
            Email me a sign-in link
          </button>
          {providers.map((p) => (
            <button
              key={p}
              type="button"
              disabled={busy}
              className="btn"
              onClick={() => void run(async () => Browser.open({ url: await session.oauthUrl(p, AUTH_REDIRECT), presentationStyle: 'popover' }))}
            >
              Continue with {PROVIDER_NAMES[p]}
            </button>
          ))}
        </form>
      ) : (
        <form
          className="mt-8 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => session.verifyCode(email.trim(), code));
          }}
        >
          <p className="text-sm text-neutral-300">
            We sent a sign-in email to <span className="font-medium">{email.trim()}</span>. Open it on this phone and tap its link; if it has a code, you can type it here instead.
          </p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Sign-in code"
            maxLength={10}
            placeholder="Code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="field text-center text-lg tracking-[0.4em]"
          />
          <button type="submit" disabled={busy || code.length < 6} className="btn-primary">
            Sign in with the code
          </button>
          <button type="button" disabled={busy} onClick={() => void send()} className="btn-quiet">
            Send another email
          </button>
          <button type="button" onClick={() => (setSent(false), setCode(''))} className="btn-quiet">
            Use another email
          </button>
        </form>
      )}
      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      {config.envName !== 'staging' && <p className="mt-10 text-xs text-neutral-600">Backend: {config.envName}</p>}
    </div>
  );
}
