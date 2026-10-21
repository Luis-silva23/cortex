'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Filiais em que o convênio pode ser usado (docs/CORTEX/policies/CONVENIOS.md). Nenhuma marcada = todas as filiais da
 * empresa. Nas demais o PDV mostra o convênio cinza: "Convênio não habilitado para esta filial".
 */
export function BranchScopePicker({ value, onChange, idPrefix }: { value: string[]; onChange: (ids: string[]) => void; idPrefix: string }) {
  const [branches, setBranches] = useState<Array<{ id: string; name: string }> | null>(null);

  useEffect(() => {
    api
      .getBranches()
      .then((res: any) => setBranches((res?.data ?? []).map((b: any) => ({ id: b.id, name: b.name }))))
      .catch(() => setBranches([]));
  }, []);

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-foreground">Filiais onde pode ser usado</legend>
      {branches === null ? (
        <p className="text-xs text-muted-foreground">Carregando filiais…</p>
      ) : branches.length === 0 ? (
        <p className="text-xs text-muted-foreground">Não foi possível listar as filiais: o convênio vale para todas.</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {branches.map((b) => (
            <label key={b.id} htmlFor={`${idPrefix}-${b.id}`} className="flex items-center gap-2 text-sm text-foreground">
              <input id={`${idPrefix}-${b.id}`} type="checkbox" checked={value.includes(b.id)} onChange={() => toggle(b.id)} />
              {b.name}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {value.length === 0 ? 'Nenhuma marcada: vale em todas as filiais.' : 'Nas outras filiais o convênio aparece indisponível no caixa.'}
      </p>
    </fieldset>
  );
}
