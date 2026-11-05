import { createSession } from '@als/client';

/**
 * Sign-in through Supabase (`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`,
 * written for dev by `pnpm dev`). Every route but signed media needs a signed-in user.
 */
function makeSession() {
  const { VITE_SUPABASE_URL: supabaseUrl, VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey } = import.meta.env;
  if (!supabaseUrl || !publishableKey) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are not set: start the editor with `pnpm dev`.');
  return createSession({ supabaseUrl, publishableKey });
}
export const session = makeSession();

/** Dev only: the seeded local user, signed in without asking (`VITE_DEV_EMAIL`, `VITE_DEV_PASSWORD`). */
export const devUser =
  import.meta.env.DEV && import.meta.env.VITE_DEV_EMAIL && import.meta.env.VITE_DEV_PASSWORD
    ? { email: import.meta.env.VITE_DEV_EMAIL as string, password: import.meta.env.VITE_DEV_PASSWORD as string }
    : undefined;
