'use client';

import { useCallback, useEffect, useState } from 'react';
import { supportAdminApi } from '@/lib/api';
import { errorText } from './format';
import type { SupportAgent, SupportCatalog } from './types';

// O catálogo é estático (muda só com deploy): uma busca por carga de página basta para todas as telas do console.
let catalogCache: SupportCatalog | null = null;
let catalogInFlight: Promise<SupportCatalog> | null = null;

function fetchCatalog(): Promise<SupportCatalog> {
  if (catalogCache) return Promise.resolve(catalogCache);
  if (!catalogInFlight) {
    catalogInFlight = supportAdminApi
      .catalog()
      .then((res) => {
        catalogCache = res.data as SupportCatalog;
        return catalogCache;
      })
      .finally(() => {
        catalogInFlight = null;
      });
  }
  return catalogInFlight;
}

export function useSupportCatalog() {
  const [catalog, setCatalog] = useState<SupportCatalog | null>(catalogCache);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!catalogCache);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setCatalog(await fetchCatalog());
    } catch (err) {
      setError(errorText(err, 'Não foi possível carregar o catálogo do suporte.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!catalogCache) load();
  }, [load]);

  return { catalog, error, loading, reload: load };
}

export function useSupportAgents() {
  const [agents, setAgents] = useState<SupportAgent[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await supportAdminApi.agents();
      setAgents(res.data as SupportAgent[]);
    } catch (err) {
      setError(errorText(err, 'Não foi possível carregar a equipe de suporte.'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { agents, error, reload: load };
}

/** Usuário logado (gravado no login em localStorage.user) — lido depois da montagem para não quebrar a hidratação. */
export function useCurrentUser() {
  const [user, setUser] = useState<{ id?: string; name?: string } | null>(null);
  useEffect(() => {
    try {
      setUser(JSON.parse(localStorage.getItem('user') || '{}'));
    } catch {
      setUser({});
    }
  }, []);
  return user;
}
