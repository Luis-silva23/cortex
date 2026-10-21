'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { THEME_STORAGE_KEY, type ThemeMode } from '@/lib/theme';

const NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<ThemeMode, string> = { system: 'Automático', light: 'Claro', dark: 'Escuro' };
const ICON = { system: Monitor, light: Sun, dark: Moon };

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Alterna Automático → Claro → Escuro. A classe `dark` inicial vem do script inline de lib/theme.ts. */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>('system');
  // Só aplica depois de ler o modo salvo: sem a trava, o estado inicial 'system' sobrescrevia o tema já aplicado.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setMode(readStoredMode());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    sync();
    if (mode === 'system') {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }
    return undefined;
  }, [mode, loaded]);

  const choose = () => {
    const next = NEXT[mode];
    setMode(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Sem armazenamento: o tema vale só nesta sessão.
    }
  };

  const Icon = ICON[mode];
  return (
    <Button variant="outline" size="sm" onClick={choose} aria-label={`Tema: ${LABEL[mode]}. Alterar tema`} title="Alterar tema">
      <Icon className="h-4 w-4 sm:mr-2" />
      <span className="sr-only sm:not-sr-only">{LABEL[mode]}</span>
    </Button>
  );
}
