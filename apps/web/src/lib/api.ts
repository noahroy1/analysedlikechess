import { createApiClient } from '@als/client';

/**
 * The editor's API client. `VITE_API_ORIGIN` points it at another backend
 * (staging, production); empty is this page's origin, which Vite proxies to the local server.
 */
export const api = createApiClient({ origin: import.meta.env.VITE_API_ORIGIN ?? '' });

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
