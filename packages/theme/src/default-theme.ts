import { DEFAULT_TYPE_OUT, type Theme } from '@als/schema';

/**
 * The app's own look. Colour families follow the usual chess annotation
 * conventions, but the values and badge art are original.
 */
export const defaultTheme: Theme = {
  id: 'default',
  name: 'Default',
  classifications: {
    brilliant: { label: 'Brilliant', phrase: 'brilliant', color: '#14b8a6', badge: { kind: 'glyph', glyph: 'double-exclaim' } },
    great: { label: 'Great', phrase: 'a great move', color: '#6aa7e8', badge: { kind: 'glyph', glyph: 'exclaim' } },
    best: { label: 'Best', phrase: 'best', color: '#3fae5a', badge: { kind: 'glyph', glyph: 'star' } },
    excellent: { label: 'Excellent', phrase: 'excellent', color: '#6cc47f', badge: { kind: 'glyph', glyph: 'thumbs-up' } },
    good: { label: 'Good', phrase: 'good', color: '#7f9f83', badge: { kind: 'glyph', glyph: 'check' } },
    book: { label: 'Book', phrase: 'a book move', color: '#b9976a', badge: { kind: 'glyph', glyph: 'book' } },
    inaccuracy: { label: 'Inaccuracy', phrase: 'an inaccuracy', color: '#e3b62d', badge: { kind: 'glyph', glyph: 'exclaim-question' } },
    mistake: { label: 'Mistake', phrase: 'a mistake', color: '#ec8a2f', badge: { kind: 'glyph', glyph: 'question' } },
    miss: { label: 'Miss', phrase: 'a miss', color: '#ee6f63', badge: { kind: 'glyph', glyph: 'cross' } },
    blunder: { label: 'Blunder', phrase: 'a blunder', color: '#d93c3c', badge: { kind: 'glyph', glyph: 'double-question' } },
  },
  card: {
    layout: 'stacked',
    // System fonts render identically in the Player and in a local render.
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    labelSize: 24,
    titleSize: 34,
    bodySize: 27,
    background: 'rgba(16, 17, 20, 0.86)',
    textColor: '#f5f5f4',
    mutedColor: '#a8a29e',
    radius: 18,
    padding: 28,
    width: 640,
    lineClamp: 5,
    badgeSize: 56,
    badgeGap: 0,
    accentWidth: 6,
    betterColor: '#3fae5a',
    chipBackground: 'rgba(255, 255, 255, 0.1)',
    chipTextColor: '#d6d3d1',
    shadow: true,
  },
  layout: {
    anchor: 'top-left',
    scale: 1,
    safeMargin: { x: 0.04, top: 0.06, bottom: 0.14 },
  },
  // Holds darken the frozen frame by 10% (the creator's call, Oct 12, 2026).
  subtitles: {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: 44,
    fontWeight: 600,
    color: '#ffffff',
    strokeColor: 'rgba(0, 0, 0, 0.85)',
    strokeWidth: 4,
    baseline: 72,
    maxWidth: 0.8,
  },
  freeze: { treatment: 'dim', dim: 0.1, pushIn: 1.04, dimInSec: 0.25 },
  timing: {
    badgeDelaySec: 0,
    badgePopSec: 0,
    cardInSec: 0.25,
    typeOut: DEFAULT_TYPE_OUT,
    cardOutSec: 0.2,
  },
};
