import { SUBTITLE_MAX_CHARS, themeUnit, type Theme } from '@als/schema';

// Where the evaluation bar, its players and the subtitle line sit, in frame
// pixels. Plain TypeScript (no JSX): the bar draws from it, card placement keeps
// clear of it, and the subtitle line moves above it on a narrow frame.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type BarStyle = NonNullable<Theme['evalBar']>;

export interface BarLayout {
  /** Pixels per bar unit: the theme unit times the project's bar size. */
  k: number;
  /** The bar's dark frame; the coloured part is inset by `frameWidth`. */
  bar: Rect;
  /** Each player's portrait, with its frame. */
  portraits: Record<'white' | 'black', Rect>;
  /** Left edge of each player's name and side, beside the portrait. */
  textLeft: number;
}

/**
 * The bar's layout. The portraits sit `inset` from the top-left and bottom-left
 * corners, sized by the theme unit and the bar size; the bar runs between them,
 * so a smaller bar size makes everything narrower and the bar a little longer.
 */
export function evalBarLayout(style: BarStyle, frame: { width: number; height: number }, scale = 1): BarLayout {
  const { height: H } = frame;
  const k = themeUnit(frame) * scale;
  const pad = style.inset * Math.min(frame.width, frame.height);
  const box = (style.portraitSize + 2 * style.frameWidth) * k;
  const black = { left: pad, top: pad, right: pad + box, bottom: pad + box };
  const white = { left: pad, top: H - pad - box, right: pad + box, bottom: H - pad };
  const bar = {
    left: pad,
    right: pad + (style.width + 2 * style.frameWidth) * k,
    top: black.bottom + style.gap.top * k,
    bottom: white.top - style.gap.bottom * k,
  };
  return { k, bar, portraits: { black, white }, textLeft: white.right + 10 * k };
}

/** Average advance of a bold sans character, in ems, for estimating a subtitle line's width. */
const SUBTITLE_EM = 0.58;

/**
 * Height of the subtitle's baseline above the frame's bottom edge, in pixels.
 * The theme's own height, unless the bar's bottom portrait is on screen and the
 * longest line could reach it (a narrow or vertical frame): then the line sits
 * just above the portrait, the same for every line so it never jumps.
 */
export function subtitleBaseline(style: NonNullable<Theme['subtitles']>, frame: { width: number; height: number }, bar?: BarLayout): number {
  const u = themeUnit(frame);
  const own = style.baseline * u;
  if (!bar) return own;
  const widest = Math.min(style.maxWidth * frame.width, SUBTITLE_MAX_CHARS * SUBTITLE_EM * style.fontSize * u);
  if (frame.width / 2 - widest / 2 > bar.portraits.white.right) return own;
  const clear = frame.height - bar.portraits.white.top + (0.25 * style.fontSize + style.strokeWidth + 8) * u;
  return Math.max(own, clear);
}
