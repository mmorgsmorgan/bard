'use client';

/**
 * Theme system: day / night / auto.
 *
 * - "auto" follows the OS `prefers-color-scheme` live (via matchMedia).
 * - The resolved theme ("light" | "dark") is written to <html data-theme>,
 *   which the CSS variables in globals.css key off of.
 * - Choice persists to localStorage. A tiny inline script (ThemeScript) sets
 *   data-theme before first paint so there is no flash of the wrong theme.
 */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
} from 'react';

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'bard-theme';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'auto') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

function apply(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('auto');
  const [resolved, setResolved] = useState<ResolvedTheme>('light');

  // Hydrate stored preference once on mount.
  useEffect(() => {
    let stored: ThemeMode = 'auto';
    try {
      const raw = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
      if (raw === 'light' || raw === 'dark' || raw === 'auto') stored = raw;
    } catch {
      /* ignore */
    }
    setModeState(stored);
    const r = resolve(stored);
    setResolved(r);
    apply(r);
  }, []);

  // When mode is "auto", track OS changes live.
  useEffect(() => {
    if (mode !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const r: ResolvedTheme = mq.matches ? 'dark' : 'light';
      setResolved(r);
      apply(r);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
    const r = resolve(m);
    setResolved(r);
    apply(r);
  }, []);

  // Cycle order: light → dark → auto → light
  const cycle = useCallback(() => {
    setMode(mode === 'light' ? 'dark' : mode === 'dark' ? 'auto' : 'light');
  }, [mode, setMode]);

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode, cycle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe fallback so components don't crash outside the provider.
    return { mode: 'auto', resolved: 'light', setMode: () => {}, cycle: () => {} };
  }
  return ctx;
}

/**
 * Inline, render-blocking script that resolves and applies the theme before
 * React hydrates — prevents a flash of the wrong theme on first paint.
 * Rendered in <head> via layout.tsx.
 */
export function ThemeScript() {
  const js = `(function(){try{var m=localStorage.getItem('${STORAGE_KEY}');if(m!=='light'&&m!=='dark'&&m!=='auto')m='auto';var d=m==='dark'||(m==='auto'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var t=d?'dark':'light';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
