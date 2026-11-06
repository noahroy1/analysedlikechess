import { createClient, type RealtimeChannel, type Session } from '@supabase/supabase-js';
import type { LiveJobs } from './client.ts';

export interface SessionOptions {
  /** The Supabase project URL. */
  supabaseUrl: string;
  /** Its publishable key (`sb_publishable_…`): safe in a client. */
  publishableKey: string;
  /** Where the session is kept (localStorage by default; Capacitor Preferences on a phone). */
  storage?: { getItem(key: string): string | null | Promise<string | null>; setItem(key: string, value: string): void | Promise<void>; removeItem(key: string): void | Promise<void> };
}

export type OAuthProvider = 'google' | 'apple';

/** The private broadcast channel a user's job updates arrive on (RLS lets only its owner join). */
export const userTopic = (userId: string) => `user:${userId}`;

/**
 * Sign-in and live updates through Supabase Auth and Realtime: the client's
 * side of PLAN-CLOUD.md "Accounts" and "Live progress". The API client takes
 * `token` and `liveJobs` from here.
 */
export function createSession(options: SessionOptions) {
  const supabaseUrl = options.supabaseUrl.replace(/\/+$/, '');
  const supabase = createClient(supabaseUrl, options.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', ...(options.storage ? { storage: options.storage } : {}) },
  });

  const check = <T extends { error: { message: string } | null }>(result: T): T => {
    if (result.error) throw new Error(result.error.message);
    return result;
  };

  /** The current access token (refreshed by supabase-js before it expires), or undefined when signed out. */
  async function token(): Promise<string | undefined> {
    return (await supabase.auth.getSession()).data.session?.access_token;
  }

  async function session(): Promise<Session | null> {
    return (await supabase.auth.getSession()).data.session;
  }

  /** Calls back with the session now and whenever it changes (sign-in, sign-out, refresh). */
  function onChange(listener: (session: Session | null) => void): () => void {
    void session().then(listener);
    const { data } = supabase.auth.onAuthStateChange((_event, next) => listener(next));
    return () => data.subscription.unsubscribe();
  }

  /**
   * Emails a 6-digit code (a new address gets an account). The email's link, where its template has one,
   * comes back to `redirectTo` with a `code` for `exchangeCode` (the phone app's own URL scheme); absent, the site URL.
   */
  async function sendCode(email: string, redirectTo?: string): Promise<void> {
    check(await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, ...(redirectTo ? { emailRedirectTo: redirectTo } : {}) } }));
  }

  /** Signs in with the `code` an email link or OAuth sign-in came back with (PKCE: only the device that asked can use it). */
  async function exchangeCode(code: string): Promise<void> {
    check(await supabase.auth.exchangeCodeForSession(code));
  }

  /** Signs in with the emailed code. */
  async function verifyCode(email: string, code: string): Promise<void> {
    check(await supabase.auth.verifyOtp({ email, token: code.trim(), type: 'email' }));
  }

  /** Sends the browser to Google or Apple; it comes back to `redirectTo` signed in. */
  async function signInWith(provider: OAuthProvider, redirectTo: string): Promise<void> {
    check(await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } }));
  }

  /**
   * The provider's sign-in page, for an in-app browser (the phone app): it comes back to `redirectTo` with a
   * `code` for `exchangeCode`, and this page stays where it is.
   */
  async function oauthUrl(provider: OAuthProvider, redirectTo: string): Promise<string> {
    const { data } = check(await supabase.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } }));
    if (!data.url) throw new Error(`no ${provider} sign-in URL`);
    return data.url;
  }

  /** Dev only: the seeded local user signs in with a password, so the editor opens straight away. */
  async function signInWithPassword(email: string, password: string): Promise<void> {
    check(await supabase.auth.signInWithPassword({ email, password }));
  }

  async function signOut(): Promise<void> {
    check(await supabase.auth.signOut());
  }

  /** Which sign-in methods the project has turned on (Google and Apple stay off until their credentials exist). */
  async function providers(): Promise<Record<OAuthProvider | 'email', boolean>> {
    const res = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: options.publishableKey } });
    const body = (await res.json().catch(() => ({}))) as { external?: Record<string, boolean> };
    return { email: body.external?.email ?? true, google: body.external?.google ?? false, apple: body.external?.apple ?? false };
  }

  /**
   * Live job updates on the user's private channel. `connected` fires on every
   * (re)subscribe, so the client reads GET /jobs then (broadcasts are not stored).
   */
  const liveJobs: LiveJobs = (handlers) => {
    let channel: RealtimeChannel | undefined;
    let closed = false;
    void (async () => {
      const current = await session();
      if (!current || closed) return;
      await supabase.realtime.setAuth(current.access_token);
      channel = supabase
        .channel(userTopic(current.user.id), { config: { private: true } })
        .on('broadcast', { event: 'job' }, (message: { payload?: unknown }) => handlers.job(message.payload))
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') handlers.connected();
        });
      if (closed) void supabase.removeChannel(channel);
    })();
    return () => {
      closed = true;
      if (channel) void supabase.removeChannel(channel);
    };
  };

  return { supabase, token, session, onChange, sendCode, verifyCode, exchangeCode, signInWith, oauthUrl, signInWithPassword, signOut, providers, liveJobs };
}

export type ClientSession = ReturnType<typeof createSession>;
