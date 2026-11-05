import { createSession } from '@als/client';

/**
 * Sign-in through Supabase when the backend is the Worker (`VITE_SUPABASE_URL`
 * and `VITE_SUPABASE_PUBLISHABLE_KEY`, written for dev by `pnpm dev`).
 * Undefined against the Node server, which has one local user and no sign-in.
 */
export const session =
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
    ? createSession({ supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY })
    : undefined;

/** Dev only: the seeded local user, signed in without asking (`VITE_DEV_EMAIL`, `VITE_DEV_PASSWORD`). */
export const devUser =
  import.meta.env.DEV && import.meta.env.VITE_DEV_EMAIL && import.meta.env.VITE_DEV_PASSWORD
    ? { email: import.meta.env.VITE_DEV_EMAIL as string, password: import.meta.env.VITE_DEV_PASSWORD as string }
    : undefined;
