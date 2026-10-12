import { z } from 'zod';

// What matters on a move's frozen frame, so its card can be placed clear of it.

/** A box on the frame, as fractions of its width and height from the top-left corner. */
export const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});
export type Box = z.infer<typeof BoxSchema>;

export const FaceRegionSchema = z.object({
  /** The whole head, hair to chin. Often loose on close-ups. */
  head: BoxSchema,
  /** Eyebrows to lower lip, across both eyes: what a card must not hide. Absent for a head seen from behind. */
  eyesMouth: BoxSchema.optional(),
});
export type FaceRegion = z.infer<typeof FaceRegionSchema>;

export const FrameRegionsSchema = z.object({
  /** The source time these were found at: once the move is retimed they are stale. */
  sourceTime: z.number().nonnegative(),
  faces: z.array(FaceRegionSchema),
  /** The one region the viewer must see to follow the move (a face, a hand, an object), if any. */
  subject: BoxSchema.optional(),
});
export type FrameRegions = z.infer<typeof FrameRegionsSchema>;

/** Same frame to well under a frame at any rate. */
export const regionsFresh = (moment: { sourceTime: number; regions?: FrameRegions | undefined }): boolean =>
  moment.regions !== undefined && Math.abs(moment.regions.sourceTime - moment.sourceTime) < 1e-4;
