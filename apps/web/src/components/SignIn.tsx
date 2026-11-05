import { useEffect, useState } from 'react';
import type { OAuthProvider } from '@als/client';
import { devUser, session } from '../lib/session.ts';

const PROVIDER_NAMES: Record<OAuthProvider, string> = { google: 'Google', apple: 'Apple' };

/**
 * Sign-in: a 6-digit code by email, or Google or Apple where they are turned
 * on (PLAN-CLOUD.md decision 8). In dev the seeded local user signs in on its own.
 */
export function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  // The dev user signs in on its own, so the form waits for it.
  const [busy, setBusy] = useState(Boolean(devUser));
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProvider[]>([]);

  useEffect(() => {
    void session
      .providers()
      .then((p) => setProviders((['google', 'apple'] as const).filter((name) => p[name])))
      .catch(() => undefined);
    if (devUser) {
      session
        .signInWithPassword(devUser.email, devUser.password)
        .catch((e: Error) => setError(`Dev sign-in failed: ${e.message}. Run pnpm dev, which seeds the dev user.`))
        .finally(() => setBusy(false));
    }
  }, []);

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    work()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const sendCode = () =>
    run(async () => {
      await session.sendCode(email.trim());
      setSent(true);
    });

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold tracking-tight">Analysed Like Chess Studio</h1>
      <p className="mt-1 mb-6 text-sm text-neutral-400">Sign in to see your projects.</p>

      {!sent ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            sendCode();
          }}
        >
          <label className="text-sm text-neutral-300" htmlFor="sign-in-email">
            Email
          </label>
          <input
            id="sign-in-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-400"
          />
          <button type="submit" disabled={busy || !email.trim()} className="rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50">
            Email me a code
          </button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => session.verifyCode(email.trim(), code));
          }}
        >
          <p className="text-sm text-neutral-300">
            We sent a 6-digit code to <span className="font-medium">{email.trim()}</span>.
          </p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Sign-in code"
            maxLength={10}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-center text-lg tracking-[0.4em] outline-none focus:border-neutral-400"
          />
          <button type="submit" disabled={busy || code.length < 6} className="rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50">
            Sign in
          </button>
          <button type="button" disabled={busy} onClick={sendCode} className="text-sm text-neutral-400 hover:text-neutral-200">
            Send a new code
          </button>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setCode('');
            }}
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            Use another email
          </button>
        </form>
      )}

      {providers.length > 0 && (
        <div className="mt-6 flex flex-col gap-2 border-t border-neutral-800 pt-6">
          {providers.map((provider) => (
            <button
              key={provider}
              type="button"
              disabled={busy}
              onClick={() => run(() => session.signInWith(provider, window.location.origin + window.location.pathname))}
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
            >
              Continue with {PROVIDER_NAMES[provider]}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
    </div>
  );
}

/** Who is signed in, and a way out. */
export function AccountMenu() {
  const [email, setEmail] = useState<string | undefined>();
  useEffect(() => session.onChange((s) => setEmail(s?.user.email)), []);
  if (!email) return null;
  return (
    <div className="flex items-center gap-3 text-sm text-neutral-400">
      <span>{email}</span>
      <button type="button" onClick={() => void session.signOut()} className="hover:text-neutral-200">
        Sign out
      </button>
    </div>
  );
}
