import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, getRemotionEnvironment } from 'remotion';
import arimoUrl from './fonts/Arimo-wght.ttf';

/**
 * Fonts shipped with the composition, so the Player and the renderer draw the
 * same glyphs on any machine (the render containers have no Arial). Arimo has
 * Arial's metrics (widths within 0.12% at 400 and 700), so layouts measured in
 * Arial hold. From google/fonts `ofl/arimo/Arimo[wght].ttf`, v1.341, weights
 * 400-700, under the SIL Open Font License 1.1 (`fonts/OFL.txt`).
 */
export const SHIPPED_FONTS = [{ family: 'Arimo', url: arimoUrl, weight: '400 700' }] as const;

let loading: Promise<void> | undefined;

/** Loads each shipped font once per page and adds it to the document. */
function loadShippedFonts(): Promise<void> {
  loading ??= Promise.all(
    SHIPPED_FONTS.map(async ({ family, url, weight }) => {
      const face = new FontFace(family, `url('${url}') format('truetype')`, { weight, style: 'normal' });
      document.fonts.add(await face.load());
    }),
  ).then(() => undefined);
  return loading;
}

/** Holds the frame until the shipped fonts are ready. A render fails rather than drawing with a fallback font. */
export function useShippedFonts(): void {
  const [handle] = useState(() => delayRender('Loading the shipped fonts'));
  useEffect(() => {
    loadShippedFonts().then(
      () => continueRender(handle),
      (error: unknown) => {
        if (getRemotionEnvironment().isRendering) cancelRender(error);
        console.warn('The shipped fonts did not load; drawing with the fallback fonts.', error);
        continueRender(handle);
      },
    );
  }, [handle]);
}
