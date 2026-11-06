import { UPLOAD_EXTENSIONS, type UploadContext } from '@als/schema';
import { App as CapApp } from '@capacitor/app';
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

export type UploadStatus = 'uploading' | 'paused' | 'failed' | 'done';

export interface UploadState {
  fileName: string;
  progress: number;
  status: UploadStatus;
  error?: string;
  projectId?: string;
}

/**
 * The one upload in flight. iOS suspends the app soon after it leaves the screen and drops its
 * connections, so a part in flight fails or hangs. Coming back, the upload starts again with the
 * same file: the client asks the server which parts it has and sends only the rest (PLAN-CLOUD.md,
 * C5: "an upload interrupted by backgrounding the app resumes from its last part").
 */
let state: UploadState | null = null;
let current: { file: File; context: UploadContext; controller: AbortController } | null = null;
let foreground = true;
const listeners = new Set<() => void>();

const set = (next: UploadState | null) => {
  state = next;
  for (const l of listeners) l();
};

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

async function run() {
  if (!current) return;
  const attempt = current;
  set({ fileName: attempt.file.name, progress: state?.progress ?? 0, status: 'uploading' });
  try {
    const project = await api.uploadClip(attempt.file, attempt.context, (p) => current === attempt && set({ ...state!, progress: p }), attempt.controller.signal);
    if (current !== attempt) return;
    current = null;
    set({ fileName: attempt.file.name, progress: 1, status: 'done', projectId: project.id });
  } catch (error) {
    // Stopped by a restart (coming back to the foreground) or by Cancel: whoever stopped it carries on.
    if (current !== attempt || isAbort(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    // Failed while away (iOS cut the connection): carry on when the app is back.
    set({ ...state!, status: foreground ? 'failed' : 'paused', error: message });
  }
}

function restart() {
  if (!current) return;
  current.controller.abort();
  current = { ...current, controller: new AbortController() };
  void run();
}

/**
 * The server takes a file by its extension. iOS's picker usually names videos `IMG_0001.MOV` or
 * `trim.<uuid>.MOV`; one with no known extension gets one from its type (the same bytes, no copy).
 */
export function withVideoExtension(file: File): File {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if ((UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) return file;
  const guess = file.type === 'video/mp4' ? 'mp4' : file.type === 'video/x-matroska' ? 'mkv' : 'mov';
  return new File([file], `${file.name || 'video'}.${guess}`, { type: file.type, lastModified: file.lastModified });
}

export const upload = {
  start(file: File, context: UploadContext) {
    current?.controller.abort();
    current = { file: withVideoExtension(file), context, controller: new AbortController() };
    state = null;
    void run();
  },
  /** Tries again after a failure, from the parts already stored. */
  retry: restart,
  cancel() {
    current?.controller.abort();
    current = null;
    set(null);
  },
  /** Forgets a finished upload once its project has opened. */
  clear() {
    if (state?.status === 'done') set(null);
  },
};

/** Watches the app leave and come back (once, at start-up). */
export function listenForAppState() {
  void CapApp.addListener('appStateChange', ({ isActive }) => {
    foreground = isActive;
    if (isActive && current && state && state.status !== 'done') {
      // Whatever was in flight when iOS suspended the app is likely dead: start the part again.
      restart();
    } else if (!isActive && state?.status === 'uploading') {
      set({ ...state, status: 'paused' });
    }
  });
}

export const getUpload = () => state;

export function subscribeUpload(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpload(): UploadState | null {
  return useSyncExternalStore(subscribeUpload, getUpload);
}
