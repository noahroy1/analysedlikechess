import { createApiClient } from '@als/client';
import { CHECK_HOOKS } from './check-hooks.ts';
import { session } from './session.ts';

/**
 * The editor's API client. `VITE_API_ORIGIN` points it at another backend
 * (staging, production); empty is this page's origin, which Vite proxies to the Worker.
 * It sends the signed-in user's token and takes live updates from Realtime.
 */
const signedIn = session;
const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? '';
export const api = createApiClient({
  origin: apiOrigin,
  token: signedIn.token,
  liveJobs: signedIn.liveJobs,
  onUnauthorized: () => void signedIn.signOut().catch(() => undefined),
});

if (CHECK_HOOKS) {
  // For the browser checks, which call the API from the page: fetch with the signed-in user's token
  // (a path under /api goes to the API's origin, as the client's calls do).
  Object.assign(window, {
    __alsToken: () => signedIn.token(),
    __alsFetch: async (input: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      const token = await signedIn.token();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(input.startsWith('/api/') ? `${apiOrigin}${input}` : input, { ...init, headers });
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
