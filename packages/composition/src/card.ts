import { typeOutSec, typeOutStartSec, typedWords, type Card, type Theme } from '@als/schema';

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
  // A badge drawn beside the card needs room on the card's left.
  const badgeRoom = theme.card.layout === 'headline' ? (theme.card.badgeSize + theme.card.badgeGap) * unit : 0;
  const mx = x * frame.width;
  const mTop = top * frame.height;
  const mBottom = bottom * frame.height;
  switch (card.anchor) {
    case 'top-left':
      return { left: mx + badgeRoom, top: mTop, width, unit };
    case 'top-right':
      return { right: mx, top: mTop, width, unit };
    case 'bottom-left':
      return { left: mx + badgeRoom, bottom: mBottom, width, unit };
    case 'bottom-right':
      return { right: mx, bottom: mBottom, width, unit };
    case 'custom':
      return { left: (card.x ?? 0) * frame.width, top: (card.y ?? 0) * frame.height, width, unit };
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInCubic = (t: number) => t ** 3;
/** Overshoots to about 110% before settling: the badge's pop. */
const easeOutBack = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

export interface CardMotion {
  /** 0-1 card opacity: fades in once the badge has popped and out at the end. */
  visibility: number;
  /** 0-1 card entrance, for the slide-in offset. */
  enter: number;
  /** Badge scale, overshooting slightly as it pops in; 1 for a badge inside the card. */
  badge: number;
  /** 0-1 badge opacity. */
  badgeVisibility: number;
  /** 0-1 strength of the freeze treatment (the dim). */
  freeze: number;
}

/**
 * Card animation from hold progress alone, so preview and render match: the
 * badge pops, then the card animates in, then (later) out. With no card-out
 * time the card stays to the hold's last frame and cuts away as playback resumes.
 */
export function cardMotion(progress: number, holdFrames: number, fps: number, theme: Pick<Theme, 'timing' | 'freeze'>): CardMotion {
  const { timing } = theme;
  const t = progress * (holdFrames / fps);
  const lastFrameSec = (holdFrames - 1) / fps;
  const cardStart = timing.badgeDelaySec + timing.badgePopSec;
  const ramp = (from: number, sec: number) => (sec > 0 ? clamp01((t - from) / sec) : t >= from ? 1 : 0);
  const enter = easeOutCubic(ramp(cardStart, timing.cardInSec));
  const exit = timing.cardOutSec > 0 ? easeInCubic(clamp01((lastFrameSec - t) / timing.cardOutSec)) : 1;
  const popped = timing.badgePopSec > 0 ? ramp(timing.badgeDelaySec, timing.badgePopSec) : 1;
  return {
    visibility: Math.min(enter, exit),
    enter,
    badge: timing.badgePopSec > 0 ? (popped > 0 ? easeOutBack(popped) : 0) : 1,
    badgeVisibility: Math.min(t >= timing.badgeDelaySec ? 1 : 0, exit),
    freeze: Math.min(ramp(0, theme.freeze.dimInSec), exit),
  };
}

/** First output frame of a hold where the card is fully in and typing starts: where Review mode stops. */
export function cardSettledFrame(holdFrames: number, fps: number, timing: Theme['timing']): number {
  return Math.min(holdFrames - 1, Math.ceil(typeOutStartSec(timing) * fps));
}

export interface Reveal {
  /** Explanation words that have started, each with its 0-1 opacity; the newest may still be fading in. */
  words: { text: string; opacity: number }[];
  /** 0-1 opacity of what follows the typed text (the best move): it fades in once the last word is in. */
  after: number;
}

/**
 * How many times faster than normal the explanation types: 1, unless a hold
 * set by hand is too short for the type-out, so the text is always complete
 * before the card leaves.
 */
export function typeOutSpeed(explanation: string, holdSec: number, timing: Theme['timing']): number {
  const natural = typeOutSec(explanation, timing.typeOut);
  const available = holdSec - typeOutStartSec(timing) - timing.cardOutSec;
  return natural > available && available > 0 ? natural / available : 1;
}

/** How much of the explanation shows `sinceStartSec` after typing starts (the card fully in). */
export function revealAt(explanation: string, sinceStartSec: number, holdSec: number, timing: Theme['timing']): Reveal {
  const { wordsPerSec, wordFadeSec } = timing.typeOut;
  const natural = typeOutSec(explanation, timing.typeOut);
  const t = Math.max(0, sinceStartSec) * typeOutSpeed(explanation, holdSec, timing);
  const fade = (start: number) => (wordFadeSec > 0 ? clamp01((t - start) / wordFadeSec) : t >= start ? 1 : 0);
  const words = typedWords(explanation)
    .map((text, i) => ({ text, opacity: fade(i / wordsPerSec) }))
    .filter((_, i) => t > i / wordsPerSec);
  return { words, after: natural === 0 ? fade(0) : fade(natural) };
}
