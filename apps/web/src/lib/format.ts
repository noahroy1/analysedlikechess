/** 83.4 -> "1:23.4" */
export function formatTime(sec: number, decimals = 1): string {
  const minutes = Math.floor(sec / 60);
  const seconds = (sec - minutes * 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${minutes}:${seconds}`;
}

/** 23.976 -> "23.976", 60 -> "60" */
export const formatFps = (fps: number) => String(Number(fps.toFixed(3)));

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
