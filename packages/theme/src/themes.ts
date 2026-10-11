import type { Theme } from '@als/schema';
import { creatorTheme } from './creator-theme.ts';
import { defaultTheme } from './default-theme.ts';

export { creatorTheme, defaultTheme };

/** Every theme a project can use, in picker order. */
export const THEMES: readonly Theme[] = [defaultTheme, creatorTheme];

/** The theme with this id, falling back to the default. */
export const getTheme = (id: string): Theme => THEMES.find((t) => t.id === id) ?? defaultTheme;
