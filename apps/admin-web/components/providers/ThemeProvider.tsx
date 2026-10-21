'use client';

import * as React from 'react';
import { THEME_STORAGE_KEY, type ThemeMode } from '@/lib/theme';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(dark: boolean) {
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Estado inicial fixo ('system') para coincidir com o HTML do servidor; a
  // preferência real é lida no efeito (a classe `dark` já foi aplicada antes
  // da pintura pelo script inline de lib/theme.ts).
  const [mode, setModeState] = React.useState<ThemeMode>('system');
  const [resolved, setResolved] = React.useState<'light' | 'dark'>('light');
  // O modo salvo só é lido depois de montar. Até lá o estado é 'system' e, sem esta
  // trava, o efeito abaixo aplicava o tema do SO por cima do que o script inline já
  // tinha posto: com "escuro" salvo e SO claro a página piscava CLARA ~50 ms a cada
  // carregamento (medido: dark → light → dark).
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    setModeState(readStoredMode());
    setLoaded(true);
  }, []);

  React.useEffect(() => {
    if (!loaded) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches);
      applyTheme(dark);
      setResolved(dark ? 'dark' : 'light');
    };
    sync();

    // Em "Automático" acompanha a troca do sistema em tempo real.
    if (mode === 'system') {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }
    return undefined;
  }, [mode, loaded]);

  const setMode = React.useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Sem armazenamento (modo privado etc.): o tema vale só nesta sessão.
    }
  }, []);

  const value = React.useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme deve ser usado dentro de ThemeProvider');
  }
  return context;
}
