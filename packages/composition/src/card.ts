import { typeOutSec, typedWords, type Card, type Theme } from '@als/schema';

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * Where a card sits, in composition pixels, as CSS edge offsets plus a width.
 * Height follows the text, so bottom-anchored cards grow upward. The editor's
 * edit layer uses the same placement so it lines up with the drawn card.
 */
export interface CardRect {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  width: number;
  /** Pixels per theme unit: theme sizes are for a 1080-pixel-tall frame. */
  unit: number;
}

export function cardRect(card: Card, frame: FrameSize, theme: Theme): CardRect {
  const unit = (frame.height / 1080) * theme.layout.scale * card.scale;
  const width = theme.card.width * unit;
  const { x, top, bottom } = theme.layout.safeMargin;
  const mx = x * frame.width;
  const mTop = top * frame.height;
  const mBottom = bottom * frame.height;
  switch (card.anchor) {
    case 'top-left':
      return { left: mx, top: mTop, width, unit };
    case 'top-right':
      return { right: mx, top: mTop, width, unit };
    case 'bottom-left':
      return { left: mx, bottom: mBottom, width, unit };
    case 'bottom-right':
      return { right: mx, bottom: mBottom, width, unit };
    case 'custom':
      return { left: (card.x ?? 0) * frame.width, top: (card.y ?? 0) * frame.height, width, unit };
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInCubic = (t: number) => t ** 3;

export interface CardMotion {
  /** 0-1 opacity: fades in at the start of the hold and out at the end. */
  visibility: number;
  /** 0-1 entrance, for the slide-in offset. */
  enter: number;
}

/**
 * Card animation from hold progress alone, so preview and render match.
 * The card is gone by the hold's last frame, so playback resumes on a clean frame.
 */
export function cardMotion(progress: number, holdFrames: number, fps: number, timing: Theme['timing']): CardMotion {
  const t = progress * (holdFrames / fps);
  const lastFrameSec = (holdFrames - 1) / fps;
  const enter = timing.cardInSec > 0 ? easeOutCubic(clamp01(t / timing.cardInSec)) : 1;
  const exit = timing.cardOutSec > 0 ? easeInCubic(clamp01((lastFrameSec - t) / timing.cardOutSec)) : 1;
  return { visibility: Math.min(enter, exit), enter };
}

/** First output frame of a hold where the card is fully in: where Review mode stops. */
export function cardSettledFrame(holdFrames: number, fps: number, timing: Theme['timing']): number {
  return Math.min(holdFrames - 1, Math.ceil(timing.cardInSec * fps));
}

export interface Reveal {
  /** Explanation words that have started, each with its 0-1 opacity; the newest may still be fading in. */
  words: { text: string; opacity: number }[];
  /** 0-1 opacity of what follows the typed text (the best move): it fades in once the last word is in. */
  after: number;
}

/**
 * How much of the explanation shows `sinceCardInSec` after the card finished
 * animating in. A hold set by hand too short for the type-out types faster,
 * so the text is always complete before the card leaves.
 */
export function revealAt(explanation: string, sinceCardInSec: number, holdSec: number, timing: Theme['timing']): Reveal {
  const { wordsPerSec, wordFadeSec } = timing.typeOut;
  const natural = typeOutSec(explanation, timing.typeOut);
  const available = holdSec - timing.cardInSec - timing.cardOutSec;
  const speed = natural > available && available > 0 ? natural / available : 1;
  const t = Math.max(0, sinceCardInSec) * speed;
  const fade = (start: number) => (wordFadeSec > 0 ? clamp01((t - start) / wordFadeSec) : t >= start ? 1 : 0);
  const words = typedWords(explanation)
    .map((text, i) => ({ text, opacity: fade(i / wordsPerSec) }))
    .filter((_, i) => t > i / wordsPerSec);
  return { words, after: natural === 0 ? fade(0) : fade(natural) };
}
