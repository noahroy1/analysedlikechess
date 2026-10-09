import type { Theme } from '@als/schema';
import { defaultTheme } from './default-theme.ts';

export { defaultTheme };

const THEMES: Record<string, Theme> = { [defaultTheme.id]: defaultTheme };

/** The theme with this id, falling back to the default. */
export const getTheme = (id: string): Theme => THEMES[id] ?? defaultTheme;
