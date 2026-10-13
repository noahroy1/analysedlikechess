import { themeUnit } from '@als/schema';
import { creatorTheme } from '@als/theme';
import { describe, expect, it } from 'vitest';
import { evalBarLayout, subtitleBaseline } from './layout.ts';

const bar = creatorTheme.evalBar!;
const subtitles = creatorTheme.subtitles!;
const landscape = { width: 1920, height: 1080 };
const vertical = { width: 576, height: 1024 };

describe('themeUnit', () => {
  it('follows the shorter side', () => {
    expect(themeUnit(landscape)).toBe(1);
    expect(themeUnit({ width: 1080, height: 1920 })).toBe(1);
    expect(themeUnit(vertical)).toBeCloseTo(576 / 1080);
  });
});

describe('evalBarLayout', () => {
  it('insets the portraits 3% of the shorter side from the corners', () => {
    for (const frame of [landscape, vertical]) {
      const { portraits } = evalBarLayout(bar, frame);
      const pad = 0.03 * Math.min(frame.width, frame.height);
      expect(portraits.black.left).toBeCloseTo(pad);
      expect(portraits.black.top).toBeCloseTo(pad);
      expect(portraits.white.bottom).toBeCloseTo(frame.height - pad);
    }
  });

  it('runs the bar between the portraits, as measured at 1080p', () => {
    const { bar: b, portraits } = evalBarLayout(bar, landscape);
    expect(b.top).toBeCloseTo(portraits.black.bottom - 2);
    expect(b.bottom).toBeCloseTo(portraits.white.top - 6);
    expect(b.right - b.left).toBeCloseTo(42 + 2 * 4);
    expect(portraits.black.right - portraits.black.left).toBeCloseTo(76 + 2 * 4);
  });

  it('shrinks every part at 90% and 80%, and the bar still meets the portraits', () => {
    const full = evalBarLayout(bar, vertical);
    for (const scale of [0.9, 0.8]) {
      const small = evalBarLayout(bar, vertical, scale);
      expect(small.k).toBeCloseTo(full.k * scale);
      expect(small.bar.right - small.bar.left).toBeCloseTo((full.bar.right - full.bar.left) * scale);
      expect(small.portraits.black.right - small.portraits.black.left).toBeCloseTo((full.portraits.black.right - full.portraits.black.left) * scale);
      // The corners stay put; the bar gets longer as the portraits shrink.
      expect(small.portraits.black.top).toBeCloseTo(full.portraits.black.top);
      expect(small.portraits.white.bottom).toBeCloseTo(full.portraits.white.bottom);
      expect(small.bar.top).toBeCloseTo(small.portraits.black.bottom - 2 * small.k);
      expect(small.bar.bottom).toBeCloseTo(small.portraits.white.top - 6 * small.k);
      expect(small.bar.bottom - small.bar.top).toBeGreaterThan(full.bar.bottom - full.bar.top);
    }
  });
});

describe('subtitleBaseline', () => {
  it('keeps the measured height on a landscape frame', () => {
    expect(subtitleBaseline(subtitles, landscape, evalBarLayout(bar, landscape))).toBe(65);
  });

  it('lifts the line above the bottom portrait on a vertical frame', () => {
    const layout = evalBarLayout(bar, vertical);
    const baseline = subtitleBaseline(subtitles, vertical, layout);
    const descent = (0.25 * subtitles.fontSize + subtitles.strokeWidth) * themeUnit(vertical);
    expect(vertical.height - baseline + descent).toBeLessThan(layout.portraits.white.top);
    // Without a bar there is nothing to clear.
    expect(subtitleBaseline(subtitles, vertical)).toBeCloseTo(65 * themeUnit(vertical));
  });
});
