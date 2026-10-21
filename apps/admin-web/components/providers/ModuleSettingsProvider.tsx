'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { SystemModule } from '@/lib/navigation';

type ModuleState = {
  disabled: ReadonlySet<SystemModule>;
  loaded: boolean;
  refresh: () => Promise<void>;
};

const ModuleSettingsContext = createContext<ModuleState>({
  disabled: new Set(),
  loaded: false,
  refresh: async () => undefined,
});

// Estado dos módulos para o menu e para a moldura do dashboard. Antes a Sidebar buscava uma vez ao montar:
// desligar um módulo em Configurações não mudava o menu até recarregar a página. Relê após alternar
// (refresh), ao voltar para a aba e ao focar a janela (outro admin pode ter mudado).
export function ModuleSettingsProvider({ children }: { children: React.ReactNode }) {
  const [disabled, setDisabled] = useState<ReadonlySet<SystemModule>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.getModuleSettings();
      setDisabled(new Set((result?.modules ?? []).filter((m: any) => !m.isEnabled).map((m: any) => m.module)));
    } catch {
      // Falha ao ler (rede): mantém o último estado; a API continua barrando o que estiver desligado.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const value = useMemo(() => ({ disabled, loaded, refresh }), [disabled, loaded, refresh]);
  return <ModuleSettingsContext.Provider value={value}>{children}</ModuleSettingsContext.Provider>;
}

export function useModuleSettings() {
  return useContext(ModuleSettingsContext);
}
