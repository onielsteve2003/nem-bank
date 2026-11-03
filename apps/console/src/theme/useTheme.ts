import { useCallback, useState } from 'react';

export type ThemeChoice = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'nem-console-theme';

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice = readChoice()): void {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function useThemeChoice(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  const update = useCallback((next: ThemeChoice) => {
    setChoice(next);
    applyTheme(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be blocked (private mode); the choice still applies for this visit.
    }
  }, []);
  return [choice, update];
}
