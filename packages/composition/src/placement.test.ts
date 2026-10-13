import type { FaceRegion, FrameRegions, Moment } from '@als/schema';
import { creatorTheme, defaultTheme } from '@als/theme';
import { describe, expect, it } from 'vitest';
import { MIN_AUTO_SCALE, autoPlaceCard, estimateCardSize, wrapLines } from './placement.ts';
import { evalBarLayout } from './layout.ts';

const frame = { width: 1920, height: 1080 };
const W = frame.width;
const H = frame.height;

const moment = (regions?: FrameRegions): Pick<Moment, 'moveLabel' | 'explanation' | 'bestMove' | 'motif' | 'classification' | 'regions'> => ({
  moveLabel: 'Splits Up',
  explanation: 'Red suggests they search the dark house in two directions. Alone, each of them is a loose piece.',
  bestMove: 'Stay Together',
  classification: 'mistake',
  ...(regions ? { regions } : {}),
});

/** A face whose eyes-to-mouth box is given in pixels. */
const face = (left: number, top: number, right: number, bottom: number): FaceRegion => {
  const box = { x: left / W, y: top / H, w: (right - left) / W, h: (bottom - top) / H };
  return { head: box, eyesMouth: box };
};

/** Eyes-to-mouth boxes tiling the frame except one gap, 200 px apart, so any overlap costs. */
function wallsAround(gapLeft: number, gapRight: number): FaceRegion[] {
  const faces: FaceRegion[] = [];
  for (let x = gapLeft; x > 0; x -= 200) faces.push(face(Math.max(0, x - 200), 0, x, H));
  for (let x = gapRight; x < W; x += 200) faces.push(face(x, 0, Math.min(W, x + 200), H));
  return faces;
}

const placed = (regions: FrameRegions, theme = defaultTheme) => autoPlaceCard({ moment: moment(regions), theme, frame })!;
const cardBox = (p: ReturnType<typeof placed>, theme = defaultTheme) => {
  const size = estimateCardSize(moment(), theme);
  const u = (H / 1080) * theme.layout.scale * p.card.scale;
  const left = p.card.x! * W;
  const top = p.card.y! * H;
  return { left, top, right: left + size.width * u, bottom: top + size.height * u };
};

describe('autoPlaceCard', () => {
  it('needs regions', () => {
    expect(autoPlaceCard({ moment: moment(), theme: defaultTheme, frame })).toBeUndefined();
  });

  it('keeps the card off a face in the open', () => {
    const regions = { sourceTime: 1, faces: [face(1200, 150, 1600, 600)] };
    const p = placed(regions);
    expect(p.card).toMatchObject({ anchor: 'custom', scale: 1, placement: 'auto' });
    expect(p.covered).toEqual({ eyesMouth: 0, face: 0, subject: 0 });
  });

  it('shrinks the card a little rather than cover eyes or a mouth', () => {
    // A gap 630 px wide: a full card (640) cannot fit, one at 92% (589) can, inside the margins.
    const gapLeft = 0.03 * W + 12 * 50;
    const p = placed({ sourceTime: 1, faces: wallsAround(gapLeft, gapLeft + 630) });
    expect(p.card.scale).toBe(0.92);
    expect(p.covered.eyesMouth).toBe(0);
  });

  it('takes the smallest card before it lets a larger one graze eyes or a mouth', () => {
    // 560 px between two faces' eyes: only the 85% card (544) fits without touching them.
    const gapLeft = 0.03 * W + 12 * 50;
    const p = placed({ sourceTime: 1, faces: wallsAround(gapLeft, gapLeft + 560) });
    expect(p.card.scale).toBe(MIN_AUTO_SCALE);
    expect(p.covered.eyesMouth).toBe(0);
  });

  it('covers part of a face rather than make the card tiny', () => {
    // A gap too narrow even for the smallest card: it never shrinks below the floor.
    const gapLeft = 0.03 * W + 12 * 50;
    const p = placed({ sourceTime: 1, faces: wallsAround(gapLeft, gapLeft + 400) });
    expect(p.card.scale).toBeGreaterThanOrEqual(MIN_AUTO_SCALE);
    expect(p.covered.eyesMouth).toBeGreaterThan(0);
  });

  it('covers the rest of a head before eyes and mouth', () => {
    // A head filling the frame, with its eyes and mouth in the middle: the card sits on the head, beside them.
    const head = { x: 0, y: 0, w: 1, h: 1 };
    const eyesMouth = { x: 0.4, y: 0.45, w: 0.2, h: 0.3 };
    const p = placed({ sourceTime: 1, faces: [{ head, eyesMouth }] });
    expect(p.covered.eyesMouth).toBe(0);
    expect(p.covered.face).toBeGreaterThan(0);
    expect(p.card.scale).toBe(1);
  });

  it('keeps clear of the evaluation bar and its players, badge included', () => {
    // Everything but the left edge is taken, so the card would go as far left as it may.
    const p = placed({ sourceTime: 1, faces: wallsAround(900, 900) }, creatorTheme);
    const badgeLeft = p.card.x! * W - (creatorTheme.card.badgeSize + creatorTheme.card.badgeGap) * p.card.scale;
    expect(badgeLeft).toBeGreaterThanOrEqual(evalBarLayout(creatorTheme.evalBar!, { width: W, height: H }).bar.right);
  });

  it('stays inside the safe area, above YouTube’s controls and the subtitles', () => {
    const p = placed({ sourceTime: 1, faces: [face(200, 60, 1800, 500)] });
    const box = cardBox(p);
    expect(box.bottom).toBeLessThanOrEqual(H * (1 - defaultTheme.layout.safeMargin.bottom) + 1e-6);
    expect(box.top).toBeGreaterThanOrEqual(H * defaultTheme.layout.safeMargin.top - 1e-6);
  });

  it('is deterministic', () => {
    const regions = { sourceTime: 1, faces: [face(700, 200, 1100, 700)], subject: { x: 0.1, y: 0.5, w: 0.2, h: 0.2 } };
    expect(placed(regions)).toEqual(placed(regions));
  });
});

describe('autoPlaceCard on a vertical frame', () => {
  const vertical = { width: 576, height: 1024 };

  it('fits the creator card and its badge inside the frame, clear of the bar', () => {
    // One face low in the frame, as in a phone clip.
    const head = { x: 0.3, y: 0.55, w: 0.4, h: 0.25 };
    const p = autoPlaceCard({ moment: moment({ sourceTime: 1, faces: [{ head, eyesMouth: head }] }), theme: creatorTheme, frame: vertical })!;
    expect(p.card.anchor).toBe('custom');
    const u = (576 / 1080) * p.card.scale;
    const size = estimateCardSize(moment(), creatorTheme);
    const left = p.card.x! * vertical.width;
    const badgeLeft = left - (creatorTheme.card.badgeSize + creatorTheme.card.badgeGap) * u;
    expect(badgeLeft).toBeGreaterThanOrEqual(evalBarLayout(creatorTheme.evalBar!, vertical).bar.right);
    expect(left + size.width * u).toBeLessThanOrEqual(vertical.width);
    expect(p.covered.eyesMouth).toBe(0);
  });

  it('sits closer to a smaller bar', () => {
    // A face down the right edge pushes the card as far left as the bar allows.
    const right = { x: 0.9, y: 0, w: 0.1, h: 1 };
    const at = (barScale?: 0.8) =>
      autoPlaceCard({ moment: moment({ sourceTime: 1, faces: [{ head: right, eyesMouth: right }] }), theme: creatorTheme, frame: vertical, barScale })!;
    expect(at(0.8).card.x!).toBeLessThan(at().card.x!);
  });
});

describe('estimateCardSize', () => {
  it('grows with the text', () => {
    const short = estimateCardSize({ ...moment(), explanation: 'He leaves.' }, creatorTheme);
    const long = estimateCardSize(moment(), creatorTheme);
    expect(long.height).toBeGreaterThan(short.height);
    expect(long.width).toBe(creatorTheme.card.width);
  });

  it('wraps words like the browser', () => {
    expect(wrapLines('', 100, 20)).toBe(0);
    expect(wrapLines('one', 1000, 20)).toBe(1);
    expect(wrapLines('one two three four five six seven', 120, 20)).toBeGreaterThan(2);
  });
});
