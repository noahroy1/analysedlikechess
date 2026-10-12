import { NO_BEST_MOVE, type Box, type Card, type Moment, type Theme } from '@als/schema';

// Places a move's card on its frozen frame, clear of what the viewer needs to
// see. Plain TypeScript (no JSX) so the server's analysis can use it too.
//
// The order of what matters (the user's, Oct 13, 2026):
//   1. eyes and mouth stay visible: the card is there to explain the drama, not hide it;
//   2. a slightly smaller card;
//   3. the rest of a face, then the move's subject;
// and a covered face is always better than a tiny card, so the card never
// shrinks below MIN_AUTO_SCALE.

/** Sizes a card may take, with what each costs against covering a face. */
export const AUTO_SCALES = [
  { scale: 1, cost: 0 },
  { scale: 0.92, cost: 30 },
  { scale: 0.85, cost: 90 },
] as const;
export const MIN_AUTO_SCALE = 0.85;

/** Cost of covering all of one region; a partly covered region costs its covered share. */
export const PLACEMENT_WEIGHTS = {
  /**
   * Any touch of a face's eyes or mouth, on top of its share: more than the
   * smallest card costs, so a card that can clear them by shrinking always does.
   */
  eyesMouthTouch: 100,
  eyesMouth: 1000,
  /** The margin around the eyes and mouth. */
  eyesMouthMargin: 200,
  face: 60,
  subject: 25,
  /** Up to this much for sitting low in the frame: the creator's cards sit high. */
  height: 4,
} as const;

/** Margin kept around the eyes-to-mouth box, as a share of its size: a card edge right at an eye still hides it. */
const BAND_MARGIN = 0.08;

/** Overlap below this share of the eyes and mouth is a rounding sliver, not a touch. */
const TOUCH = 0.002;

const grow = (b: Box, by: number): Box => ({ x: b.x - by * b.w, y: b.y - by * b.h, w: b.w * (1 + 2 * by), h: b.h * (1 + 2 * by) });

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  card: Card;
  /** The largest share of any face's eyes-to-mouth band, and of any face, the card covers. */
  covered: { eyesMouth: number; face: number; subject: number };
}

export interface PlaceInput {
  moment: Pick<Moment, 'moveLabel' | 'explanation' | 'bestMove' | 'motif' | 'classification' | 'regions'>;
  theme: Theme;
  frame: { width: number; height: number };
  /** The grey line's text ("2... Walter White"), which can wrap. */
  who?: string;
}

/**
 * The best place for the card given the frame's regions, or undefined without
 * regions. Deterministic: the same frame and text always give the same card.
 */
export function autoPlaceCard({ moment, theme, frame, who }: PlaceInput): Placement | undefined {
  const regions = moment.regions;
  if (!regions) return undefined;
  const { width: W, height: H } = frame;
  const k = H / 1080;
  const toRect = (b: Box): Rect => ({ left: b.x * W, top: b.y * H, right: (b.x + b.w) * W, bottom: (b.y + b.h) * H });
  const faces = regions.faces.map((f) => ({
    face: toRect(f.head),
    band: f.eyesMouth ? toRect(f.eyesMouth) : undefined,
    margin: f.eyesMouth ? toRect(grow(f.eyesMouth, BAND_MARGIN)) : undefined,
  }));
  const subject = regions.subject ? toRect(regions.subject) : undefined;
  const bounds = placementBounds(theme, frame);
  const zones = noGoZones(theme, frame);
  const step = Math.max(4, Math.round(12 * k));

  const size = estimateCardSize(moment, theme, who);
  let best: { cost: number; placement: Placement } | undefined;
  for (const { scale, cost: scaleCost } of AUTO_SCALES) {
    const u = k * theme.layout.scale * scale;
    const w = size.width * u;
    const h = size.height * u;
    const badge = theme.card.layout === 'headline' ? { size: theme.card.badgeSize * u, gap: theme.card.badgeGap * u } : undefined;
    const minLeft = bounds.left + (badge ? badge.size + badge.gap : 0);
    for (let top = bounds.top; top + h <= bounds.bottom; top += step) {
      for (let left = minLeft; left + w <= bounds.right; left += step) {
        const parts: Rect[] = [{ left, top, right: left + w, bottom: top + h }];
        // A headline badge sits beside the card's left edge, from 0.6 of its size down.
        if (badge) parts.push({ left: left - badge.gap - badge.size, top: top + 0.6 * badge.size, right: left - badge.gap, bottom: top + 1.6 * badge.size });
        if (parts.some((p) => zones.some((z) => overlap(p, z) > 0))) continue;
        const covered = {
          eyesMouth: Math.max(0, ...faces.map((f) => (f.band ? coverage(parts, f.band) : 0))),
          face: Math.max(0, ...faces.map((f) => coverage(parts, f.face))),
          subject: subject ? coverage(parts, subject) : 0,
        };
        const cost =
          faces.reduce((sum, f) => {
            const band = f.band ? coverage(parts, f.band) : 0;
            const touch = band > TOUCH ? PLACEMENT_WEIGHTS.eyesMouthTouch + PLACEMENT_WEIGHTS.eyesMouth * band : 0;
            const margin = f.margin ? PLACEMENT_WEIGHTS.eyesMouthMargin * coverage(parts, f.margin) : 0;
            return sum + touch + margin + PLACEMENT_WEIGHTS.face * coverage(parts, f.face);
          }, 0) +
          (subject ? PLACEMENT_WEIGHTS.subject * coverage(parts, subject) : 0) +
          scaleCost +
          PLACEMENT_WEIGHTS.height * (top / H);
        if (!best || cost < best.cost - 1e-9) {
          best = {
            cost,
            placement: { card: { anchor: 'custom', x: round4(left / W), y: round4(top / H), scale, placement: 'auto' }, covered },
          };
        }
      }
    }
  }
  return best?.placement ?? { card: { anchor: theme.layout.anchor, scale: 1, placement: 'auto' }, covered: { eyesMouth: 0, face: 0, subject: 0 } };
}

/** Where a card may go: inside the frame's safe area (YouTube's controls and the subtitles below). */
function placementBounds(theme: Theme, { width: W, height: H }: { width: number; height: number }): Rect {
  const edge = 0.03 * W;
  return { left: edge, top: theme.layout.safeMargin.top * H, right: W - edge, bottom: H - theme.layout.safeMargin.bottom * H };
}

/** The evaluation bar and the players' portraits and names beside it. */
function noGoZones(theme: Theme, { width: W, height: H }: { width: number; height: number }): Rect[] {
  const bar = theme.evalBar;
  if (!bar) return [];
  const k = H / 1080;
  const fw = bar.frameWidth;
  const box = bar.portraitSize + 2 * fw;
  // Room for a long name beside each portrait.
  const tagWidth = bar.left - fw + box + 10 + 300;
  const topTag = bar.top - fw - box + 2;
  const bottomTag = 1080 - bar.bottom + fw + 6;
  return [
    { left: 0, top: 0, right: (bar.left + bar.width + fw + 24) * k, bottom: H },
    { left: 0, top: (topTag - 8) * k, right: tagWidth * k, bottom: (topTag + box + 8) * k },
    { left: 0, top: (bottomTag - 8) * k, right: tagWidth * k, bottom: Math.min(H, (bottomTag + box + 8) * k) },
  ].map((r) => ({ ...r, right: Math.min(r.right, W) }));
}

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Share of `region` under the (non-overlapping) parts. */
function coverage(parts: Rect[], region: Rect): number {
  const area = (region.right - region.left) * (region.bottom - region.top);
  if (area <= 0) return 0;
  return Math.min(1, parts.reduce((sum, p) => sum + overlap(p, region), 0) / area);
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

// Card size, estimated without a browser: the same blocks MoveCard draws, with
// text wrapped on Arial-like character widths. Theme units (a 1080-pixel-tall frame).

/** Average advance of a character, in ems, for a Helvetica/Arial-like face. */
function charEm(ch: string): number {
  if (ch === ' ') return 0.278;
  if ('iljtf.,;:\'!|'.includes(ch)) return 0.3;
  if ('mw'.includes(ch)) return 0.83;
  if ('MW'.includes(ch)) return 0.88;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[0-9]/.test(ch)) return 0.556;
  return 0.53;
}

/** Lines a text wraps to at a width, greedy by word like the browser. */
export function wrapLines(text: string, widthPx: number, fontPx: number, bold = false): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const em = fontPx * (bold ? 1.07 : 1);
  const measure = (s: string) => [...s].reduce((sum, ch) => sum + charEm(ch), 0) * em;
  const space = charEm(' ') * em;
  let lines = 1;
  let line = 0;
  for (const word of words) {
    const w = measure(word);
    if (line > 0 && line + space + w > widthPx) {
      lines++;
      line = w;
    } else {
      line += (line > 0 ? space : 0) + w;
    }
  }
  return lines;
}

/** Lines of breakdown in a card whose text is still to come: the creator's two sentences. */
const TYPICAL_BODY_LINES = 4;

/** The card's width and height in theme units, with its text. */
export function estimateCardSize(moment: PlaceInput['moment'], theme: Theme, who = ''): { width: number; height: number } {
  const { card } = theme;
  const style = theme.classifications[moment.classification];
  const inner = card.width - 2 * card.padding - card.accentWidth;
  // A move with no text yet (just added) is sized as a typical full card, so the text still fits once written.
  const blank = !moment.explanation.trim();
  const bodyLines = blank ? TYPICAL_BODY_LINES : Math.min(card.lineClamp, wrapLines(moment.explanation, inner, card.bodySize));
  const hasBest = (blank || Boolean(moment.bestMove?.trim())) && !NO_BEST_MOVE.has(moment.classification);
  const hasMotif = blank || Boolean(moment.motif?.trim());
  let height = 2 * card.padding;
  if (card.layout === 'headline') {
    height += wrapLines(`${moment.moveLabel} is ${style.phrase}`, inner, card.titleSize, true) * card.titleSize * 1.2;
    height += 4 + Math.max(1, wrapLines(`${who} · ${moment.moveLabel}!!`, inner, card.labelSize, true)) * card.labelSize * 1.3;
    if (bodyLines) height += 12 + bodyLines * card.bodySize * 1.33;
    if (hasBest) height += 12 + Math.max(28, wrapLines(`Better was: ${moment.bestMove}`, inner - 38, card.labelSize, true) * card.labelSize * 1.3);
    if (hasMotif) height += 12 + card.labelSize * 0.86 * 1.25 + 10;
  } else {
    const titleWidth = inner - card.badgeSize - 18;
    const title = card.labelSize * 1.1 + 4 + wrapLines(`${who}: ${moment.moveLabel}`, titleWidth, card.titleSize, true) * card.titleSize * 1.18;
    height += Math.max(card.badgeSize, title);
    if (bodyLines) height += 16 + bodyLines * card.bodySize * 1.36;
    if (hasBest) height += 30 + wrapLines(`BEST MOVE ${moment.bestMove}`, inner, card.bodySize * 0.92) * card.bodySize * 0.92 * 1.32;
    if (hasMotif) height += 12 + card.labelSize * 0.86 * 1.25 + 10;
  }
  return { width: card.width, height };
}
