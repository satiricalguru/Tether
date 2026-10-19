import { useEffect } from 'react';
import type { Theme } from '@/lib/settings';

/** Reflect the theme setting onto <html data-theme>; "system" defers to the OS. */
export function useApplyTheme(theme: Theme | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!theme || theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
}
