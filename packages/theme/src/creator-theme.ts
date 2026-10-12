import { DEFAULT_REREAD_SEC, DEFAULT_TYPE_OUT, type Theme } from '@als/schema';

/**
 * The creator's look, measured on their videos (`media/creator-ref/`, Oct 12, 2026):
 * a round badge beside the card, "<Move> is <phrase>" in the rating colour, a grey
 * move-number line, the breakdown typing out, then "Better was" and a motif chip.
 * Brilliant, great, best and inaccuracy colours are sampled from their frames.
 * TODO(open-decision): the other six ratings have no reference frames yet; their
 * colours are placeholders in the same families until we sample a video that uses them.
 */
export const creatorTheme: Theme = {
  id: 'creator',
  name: 'Creator',
  classifications: {
    brilliant: { label: 'Brilliant', phrase: 'brilliant', color: '#419ba7', badge: { kind: 'glyph', glyph: 'double-exclaim' } },
    great: { label: 'Great', phrase: 'a great move', color: '#6386b1', badge: { kind: 'glyph', glyph: 'exclaim' } },
    best: { label: 'Best', phrase: 'best', color: '#93b146', badge: { kind: 'glyph', glyph: 'star' } },
    excellent: { label: 'Excellent', phrase: 'excellent', color: '#7fb04f', badge: { kind: 'glyph', glyph: 'thumbs-up' } },
    good: { label: 'Good', phrase: 'good', color: '#8fa686', badge: { kind: 'glyph', glyph: 'check' } },
    book: { label: 'Book', phrase: 'a book move', color: '#a98a68', badge: { kind: 'glyph', glyph: 'book' } },
    inaccuracy: { label: 'Inaccuracy', phrase: 'an inaccuracy', color: '#f2c247', badge: { kind: 'glyph', glyph: 'exclaim-question' } },
    mistake: { label: 'Mistake', phrase: 'a mistake', color: '#e5913a', badge: { kind: 'glyph', glyph: 'question' } },
    miss: { label: 'Miss', phrase: 'a miss', color: '#e46f5c', badge: { kind: 'glyph', glyph: 'cross' } },
    blunder: { label: 'Blunder', phrase: 'a blunder', color: '#c9433b', badge: { kind: 'glyph', glyph: 'double-question' } },
  },
  card: {
    layout: 'headline',
    fontFamily: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
    labelSize: 22,
    titleSize: 34,
    bodySize: 30,
    background: 'rgba(34, 33, 29, 0.9)',
    textColor: '#ffffff',
    mutedColor: '#a29f9a',
    radius: 14,
    padding: 22,
    width: 640,
    lineClamp: 6,
    badgeSize: 184,
    badgeGap: 24,
    accentWidth: 9,
    betterColor: '#9cad5a',
    chipBackground: 'rgba(255, 255, 255, 0.12)',
    chipTextColor: '#dad7d3',
    shadow: false,
  },
  layout: {
    anchor: 'top-right',
    scale: 1,
    safeMargin: { x: 0.17, top: 0.055, bottom: 0.14 },
  },
  // Measured on style-ref-*.png (1080p): a Chess.com-style bar whose coloured
  // part spans x 26-67 and y 112-968, in a 4 px dark frame, between 76 px portraits.
  // Measured on the creator's videos (Oct 12, 2026) and checked against a 1080p
  // frame of ours: Arial Bold 50 px, white with a 5 px black outline outside the
  // letters, centred, baseline 65 px above the bottom.
  subtitles: {
    fontFamily: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
    fontSize: 50,
    fontWeight: 700,
    color: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 5,
    baseline: 65,
    maxWidth: 0.9,
  },
  evalBar: {
    left: 26,
    width: 42,
    top: 112,
    bottom: 112,
    frameWidth: 4,
    frameColor: 'rgba(12, 10, 6, 0.6)',
    whiteColor: '#fefefe',
    blackColor: '#403d3a',
    labelSize: 15,
    whiteTextColor: '#403d3a',
    blackTextColor: '#fefefe',
    portraitSize: 76,
    nameSize: 28,
    sideSize: 18,
    nameColor: '#ffffff',
    sideColor: '#d9d6d1',
  },
  // The dim lands on the first frozen frame; the card cuts away as playback resumes.
  freeze: { treatment: 'dim', dim: 0.1, pushIn: 1.04, dimInSec: 0 },
  timing: {
    badgeDelaySec: 0.3,
    badgePopSec: 0.2,
    cardInSec: 0.25,
    typeOut: DEFAULT_TYPE_OUT,
    rereadSec: DEFAULT_REREAD_SEC,
    cardOutSec: 0,
  },
};
