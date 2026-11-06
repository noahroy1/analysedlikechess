import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { api } from './api.ts';

/**
 * Shares a finished render through the iOS share sheet (Messages, Save Video, AirDrop…): the MP4 is
 * downloaded natively into the app's cache (no copy through the web view), shared as a file, then deleted.
 * `Filesystem.downloadFile` is deprecated in favour of `@capacitor/file-transfer`, a separate plugin;
 * it still works in 8.x. TODO: move to file-transfer if a later Filesystem drops it.
 */
export async function shareRender(projectId: string, renderId: string, name: string, onProgress: (p: number) => void): Promise<void> {
  const url = await api.downloadUrl(projectId, renderId);
  const path = `renders/${safeName(name)}.mp4`;
  const listener = await Filesystem.addListener('progress', (p) => {
    if (p.contentLength > 0) onProgress(p.bytes / p.contentLength);
  });
  try {
    await Filesystem.downloadFile({ url, path, directory: Directory.Cache, recursive: true, progress: true });
    // Progress events are throttled and may stop short of the end.
    onProgress(1);
  } finally {
    void listener.remove();
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  try {
    await Share.share({ files: [uri] });
  } catch (error) {
    // Closing the sheet without picking anything is not a failure.
    if (!/cancel/i.test((error as Error).message)) throw error;
  } finally {
    void Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
  }
}

const safeName = (name: string) => name.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 80) || 'episode';
