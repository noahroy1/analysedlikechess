/**
 * Which backend this build talks to, set by `scripts/ios.ts` at build time: staging for the phone,
 * or local dev (the simulator only: the phone can't reach the Mac's loopback).
 */
const env = import.meta.env;

function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set: build with \`node scripts/ios.ts build <local|staging>\`.`);
  return value;
}

export const config = {
  envName: env.VITE_ENV_NAME ?? 'unknown',
  apiOrigin: need('VITE_API_ORIGIN', env.VITE_API_ORIGIN),
  supabaseUrl: need('VITE_SUPABASE_URL', env.VITE_SUPABASE_URL),
  publishableKey: need('VITE_SUPABASE_PUBLISHABLE_KEY', env.VITE_SUPABASE_PUBLISHABLE_KEY),
};

/**
 * Where sign-in links and OAuth come back to: the app's own URL scheme (`CFBundleURLSchemes` in
 * `ios/App/App/Info.plist`, and each environment's redirect URLs in `supabase/config.toml`). A custom scheme,
 * not a universal link: those need the paid Apple Developer account (associated domains).
 */
export const AUTH_REDIRECT = 'com.noahroy.alstrial://auth/callback';
