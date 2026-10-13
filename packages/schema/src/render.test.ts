import { describe, expect, it } from 'vitest';
import { presetSize } from './render.ts';

describe('presetSize', () => {
  it('keeps the source size', () => {
    expect(presetSize({ width: 1920, height: 1080 }, 'source')).toEqual({ scale: 1, width: 1920, height: 1080 });
  });

  it('scales the shorter side to a standard size', () => {
    expect(presetSize({ width: 1280, height: 720 }, '1080p')).toEqual({ scale: 1.5, width: 1920, height: 1080 });
    expect(presetSize({ width: 1920, height: 1080 }, '2160p')).toEqual({ scale: 2, width: 3840, height: 2160 });
    // A vertical clip: 1080p is 1080×1920.
    expect(presetSize({ width: 576, height: 1024 }, '1080p')).toEqual({ scale: 1.875, width: 1080, height: 1920 });
  });

  it('refuses sizes H.264 cannot encode', () => {
    expect(presetSize({ width: 1000, height: 562 }, '1080p')).toBeUndefined();
    expect(presetSize({ width: 1279, height: 720 }, 'source')).toBeUndefined();
  });
});
