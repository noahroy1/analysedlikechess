import type { Theme } from '@als/schema';
import { creatorTheme } from './creator-theme.ts';
import { defaultTheme } from './default-theme.ts';

export { creatorTheme, defaultTheme };

/**
 * The one look projects use (the user's call, Nov 4): new projects get it, and
 * the editor moves older projects onto it. Users cannot pick another look; the
 * others stay for internal use (tests and the dev-only `window.__alsSetLook`).
 */
export const PROJECT_THEME_ID = creatorTheme.id;

/** Every theme the code knows. */
export const THEMES: readonly Theme[] = [creatorTheme, defaultTheme];

/** The theme with this id, falling back to the project look. */
export const getTheme = (id: string): Theme => THEMES.find((t) => t.id === id) ?? creatorTheme;
