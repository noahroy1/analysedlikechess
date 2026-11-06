import { createSession } from '@als/client';
import { config } from './config.ts';

/**
 * Sign-in through Supabase, kept in the web view's localStorage (the app's own, persistent store; the PKCE
 * verifier for an emailed link waits there too, so only this phone can use the link it asked for).
 */
export const session = createSession({ supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey });
