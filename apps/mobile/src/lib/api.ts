import { createApiClient } from '@als/client';
import { config } from './config.ts';
import { session } from './session.ts';

/** The app's API client: the deployed (or local) Worker, the signed-in user's token and live jobs by Realtime. */
export const api = createApiClient({
  origin: config.apiOrigin,
  token: session.token,
  liveJobs: session.liveJobs,
  onUnauthorized: () => void session.signOut().catch(() => undefined),
});
