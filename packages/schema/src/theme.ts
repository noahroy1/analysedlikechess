import { z } from 'zod';
import { ClassificationSchema } from './classification.ts';
import { CARD_ANCHORS } from './project.ts';

const Unit = z.number().min(0).max(1);

/** Built-in badge glyphs, drawn as original SVG on the standard chess annotation symbols. */
export const BADGE_GLYPHS = [
  'double-exclaim',
  'exclaim',
  'star',
  'thumbs-up',
  'check',
  'book',
  'exclaim-question',
  'question',
  'cross',
  'double-question',
] as const;

export const BadgeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('glyph'), glyph: z.enum(BADGE_GLYPHS) }),
  /** A creator's own badge art: a URL the Player and the renderer can both load. */
  z.object({ kind: z.literal('image'), src: z.string().min(1) }),
]);
export type Badge = z.infer<typeof BadgeSchema>;

export const ClassificationStyleSchema = z.object({
  label: z.string(),
  /** Completes the headline "<move> is <phrase>", e.g. "a great move". */
  phrase: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  badge: BadgeSchema,
});
export type ClassificationStyle = z.infer<typeof ClassificationStyleSchema>;

/** The explanation streams in once the card is in: a word starts every 1 / wordsPerSec seconds and fades in over wordFadeSec. */
export const TypeOutSchema = z.object({ wordsPerSec: z.number().positive(), wordFadeSec: z.number().nonnegative() });
export type TypeOut = z.infer<typeof TypeOutSchema>;

/**
 * Every visual choice for cards and holds. Pixel sizes are for a 1080-pixel-tall
 * frame and scale with the frame height and the moment's `card.scale`.
 */
export const ThemeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  classifications: z.record(ClassificationSchema, ClassificationStyleSchema),
  card: z.object({
    /**
     * `stacked`: badge inside the card, rating label over "Actor: Move".
     * `headline`: badge beside the card, "<Move> is <phrase>" in the rating colour, then
     * "<number> <actor> · <Move><notation>", the breakdown, the better move and the motif chip.
     */
    layout: z.enum(['stacked', 'headline']),
    fontFamily: z.string(),
    labelSize: z.number().positive(),
    titleSize: z.number().positive(),
    bodySize: z.number().positive(),
    background: z.string(),
    textColor: z.string(),
    mutedColor: z.string(),
    radius: z.number().nonnegative(),
    padding: z.number().nonnegative(),
    width: z.number().positive(),
    /** Explanation lines shown before truncating. */
    lineClamp: z.int().positive(),
    badgeSize: z.number().positive(),
    /** Gap between the card and a badge drawn beside it (`headline`). */
    badgeGap: z.number().nonnegative(),
    /** Width of the rating-coloured edge on the card's left. */
    accentWidth: z.number().nonnegative(),
    /** "Better was" line colour (`headline`). */
    betterColor: z.string(),
    chipBackground: z.string(),
    chipTextColor: z.string(),
    shadow: z.boolean(),
  }),
  layout: z.object({
    anchor: z.enum(CARD_ANCHORS).exclude(['custom']),
    scale: z.number().positive(),
    /** Fractions of the frame kept clear at each edge; `bottom` clears YouTube's player controls. */
    safeMargin: z.object({ x: Unit, top: Unit, bottom: Unit }),
  }),
  /**
   * An evaluation bar on the left edge, Black's player at the top and White's at
   * the bottom, each with a portrait. Absent: no bar. Sizes are for a 1080-pixel-tall frame.
   */
  evalBar: z
    .object({
      /** The bar's coloured part, without its frame. */
      left: z.number().nonnegative(),
      width: z.number().positive(),
      top: z.number().nonnegative(),
      bottom: z.number().nonnegative(),
      /** Dark edge around the bar and the portraits. */
      frameWidth: z.number().nonnegative(),
      frameColor: z.string(),
      whiteColor: z.string(),
      blackColor: z.string(),
      /** The value label, in each side's text colour. */
      labelSize: z.number().positive(),
      whiteTextColor: z.string(),
      blackTextColor: z.string(),
      portraitSize: z.number().positive(),
      nameSize: z.number().positive(),
      sideSize: z.number().positive(),
      nameColor: z.string(),
      sideColor: z.string(),
    })
    .optional(),
  freeze: z.object({
    treatment: z.enum(['none', 'dim', 'push-in']),
    /** Darkening at full strength, for `dim`. */
    dim: Unit,
    /** Final zoom across the hold, for `push-in`. */
    pushIn: z.number().min(1).max(1.5),
    /** Seconds the dim takes to come in; 0 is instant, on the first frozen frame. */
    dimInSec: z.number().nonnegative(),
  }),
  timing: z.object({
    /** A badge beside the card (`headline`) pops in first: after this delay, over `badgePopSec`. 0 and 0 for a badge inside the card. */
    badgeDelaySec: z.number().nonnegative(),
    badgePopSec: z.number().nonnegative(),
    /** The card animates in once the badge has popped; the type-out starts when it is in. */
    cardInSec: z.number().nonnegative(),
    typeOut: TypeOutSchema,
    /** How long the finished card stays up before it leaves. */
    rereadSec: z.number().nonnegative(),
    cardOutSec: z.number().nonnegative(),
    /** Optional sound when a card appears: a URL the Player and the renderer can both load. */
    sting: z.string().optional(),
  }),
});
export type Theme = z.infer<typeof ThemeSchema>;
