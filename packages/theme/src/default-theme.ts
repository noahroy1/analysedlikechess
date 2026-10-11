import { DEFAULT_REREAD_SEC, DEFAULT_TYPE_OUT, type Theme } from '@als/schema';

/**
 * The app's own look. Colour families follow the usual chess annotation
 * conventions, but the values and badge art are original.
 * TODO(open-decision): the pitch build adds a `creator` theme matching their videos (Phase 6).
 */
export const defaultTheme: Theme = {
  id: 'default',
  name: 'Default',
  classifications: {
    brilliant: { label: 'Brilliant', color: '#14b8a6', badge: { kind: 'glyph', glyph: 'double-exclaim' } },
    great: { label: 'Great', color: '#6aa7e8', badge: { kind: 'glyph', glyph: 'exclaim' } },
    best: { label: 'Best', color: '#3fae5a', badge: { kind: 'glyph', glyph: 'star' } },
    excellent: { label: 'Excellent', color: '#6cc47f', badge: { kind: 'glyph', glyph: 'thumbs-up' } },
    good: { label: 'Good', color: '#7f9f83', badge: { kind: 'glyph', glyph: 'check' } },
    book: { label: 'Book', color: '#b9976a', badge: { kind: 'glyph', glyph: 'book' } },
    inaccuracy: { label: 'Inaccuracy', color: '#e3b62d', badge: { kind: 'glyph', glyph: 'exclaim-question' } },
    mistake: { label: 'Mistake', color: '#ec8a2f', badge: { kind: 'glyph', glyph: 'question' } },
    miss: { label: 'Miss', color: '#ee6f63', badge: { kind: 'glyph', glyph: 'cross' } },
    blunder: { label: 'Blunder', color: '#d93c3c', badge: { kind: 'glyph', glyph: 'double-question' } },
  },
  card: {
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
    shadow: true,
  },
  layout: {
    anchor: 'top-left',
    scale: 1,
    safeMargin: { x: 0.04, top: 0.06, bottom: 0.14 },
  },
  // Holds darken the frozen frame by 10% (the creator's call, Oct 12, 2026).
  freeze: { treatment: 'dim', dim: 0.1, pushIn: 1.04 },
  timing: {
    cardInSec: 0.25,
    typeOut: DEFAULT_TYPE_OUT,
    rereadSec: DEFAULT_REREAD_SEC,
    cardOutSec: 0.2,
  },
};
