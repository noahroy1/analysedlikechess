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
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  badge: BadgeSchema,
});
export type ClassificationStyle = z.infer<typeof ClassificationStyleSchema>;

/**
 * Every visual choice for cards and holds. Pixel sizes are for a 1080-pixel-tall
 * frame and scale with the frame height and the moment's `card.scale`.
 */
export const ThemeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  classifications: z.record(ClassificationSchema, ClassificationStyleSchema),
  card: z.object({
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
    shadow: z.boolean(),
  }),
  layout: z.object({
    anchor: z.enum(CARD_ANCHORS).exclude(['custom']),
    scale: z.number().positive(),
    /** Fractions of the frame kept clear at each edge; `bottom` clears YouTube's player controls. */
    safeMargin: z.object({ x: Unit, top: Unit, bottom: Unit }),
  }),
  freeze: z.object({
    treatment: z.enum(['none', 'dim', 'push-in']),
    /** Darkening at full strength, for `dim`. */
    dim: Unit,
    /** Final zoom across the hold, for `push-in`. */
    pushIn: z.number().min(1).max(1.5),
  }),
  timing: z.object({
    hold: z.object({ floorSec: z.number().positive(), wordsPerSec: z.number().positive() }),
    cardInSec: z.number().nonnegative(),
    cardOutSec: z.number().nonnegative(),
    /** Optional sound when a card appears: a URL the Player and the renderer can both load. */
    sting: z.string().optional(),
  }),
});
export type Theme = z.infer<typeof ThemeSchema>;
