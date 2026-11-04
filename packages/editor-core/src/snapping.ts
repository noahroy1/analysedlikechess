import { cleanFreezeTime, type Shot } from '@als/schema';

export interface SnapContext {
  /** Freeze times right after each word (speechSnapTargets). */
  targets: readonly number[];
  shots: readonly Shot[];
  fps: number;
}

export type SnapKind = 'speech' | 'clean' | 'free';

/**
 * Where a dragged or added moment lands. With snapping on it jumps to the end
 * of nearby speech, otherwise to a frame clear of cuts; with snapping off
 * (Shift) it lands on the nearest frame.
 */
export function snapTime(raw: number, ctx: SnapContext, snap: boolean, toleranceSec: number): { sec: number; kind: SnapKind } {
  if (!snap) return { sec: Math.round(raw * ctx.fps) / ctx.fps, kind: 'free' };
  let best: number | undefined;
  for (const t of ctx.targets) {
    if (Math.abs(t - raw) <= toleranceSec && (best === undefined || Math.abs(t - raw) < Math.abs(best - raw))) best = t;
  }
  if (best !== undefined) return { sec: best, kind: 'speech' };
  return { sec: cleanFreezeTime(raw, ctx.shots, ctx.fps), kind: 'clean' };
}
