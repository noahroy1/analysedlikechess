import { createApiClient } from '@als/client';
import { session } from './session.ts';

/**
 * The editor's API client. `VITE_API_ORIGIN` points it at another backend
 * (staging, production); empty is this page's origin, which Vite proxies to the local server.
 * Signed in, it sends the user's token and takes live updates from Realtime.
 */
const signedIn = session;
export const api = createApiClient({
  origin: import.meta.env.VITE_API_ORIGIN ?? '',
  ...(signedIn ? { token: signedIn.token, liveJobs: signedIn.liveJobs, onUnauthorized: () => void signedIn.signOut().catch(() => undefined) } : {}),
});

if (import.meta.env.DEV && signedIn) {
  // For the browser checks, which call the API from the page: fetch with the signed-in user's token.
  Object.assign(window, {
    __alsToken: () => signedIn.token(),
    __alsFetch: async (input: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      const token = await signedIn.token();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
  });
}

export const {
  listProjects,
  getProject,
  saveProject,
  listHistory,
  restoreVersion,
  rerunIngest,
  deleteProject,
  getSoundBank,
  getAnalysisConfig,
  startAnalysis,
  findRegions,
  regenerateMoment,
  getUsage,
  evaluateTrack,
  createPortrait,
  listRenders,
  startRender,
  cancelRender,
  deleteRender,
  downloadUrl,
  fileUrl,
  loadMedia,
  forgetMedia,
  mediaExpiresAt,
  uploadClip,
} = api;

export type { AnalysisConfigInfo } from '@als/schema';
