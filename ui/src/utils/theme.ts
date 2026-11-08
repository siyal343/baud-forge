import { BfMode, BfTheme } from '../store/useSettingsStore';

/**
 * Point the document at the active theme's token set (index.css swaps the
 * --color-bf-* variables off these attributes). Called before the first
 * render from main.tsx and reactively from App whenever settings change.
 */
export const applyTheme = (theme: BfTheme, mode: BfMode): void => {
  const el = document.documentElement;
  el.setAttribute('data-bf-theme', theme);
  el.setAttribute('data-bf-mode', mode);
};
