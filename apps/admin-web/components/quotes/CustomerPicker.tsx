'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Search, User, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useDebounce } from '@/lib/hooks/useDebounce';

export interface CustomerOption {
  id: string;
  name: string;
  phone?: string | null;
  mobile?: string | null;
  document?: string | null;
}

interface CustomerPickerProps {
  value: CustomerOption | null;
  onChange: (customer: CustomerOption | null) => void;
  disabled?: boolean;
}

// Busca no servidor (nome/telefone/documento) em vez de carregar "todos os
// clientes" num <select>: o backend limita `limit` a 100 por página, então
// uma empresa com mais clientes do que isso nunca conseguiria escolher os
// demais numa lista fixa.
export function CustomerPicker({ value, onChange, disabled }: CustomerPickerProps) {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (value) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getCustomers({ search: debounced || undefined, limit: 8, isActive: true })
      .then((res) => {
        if (!cancelled) setResults(res?.customers ?? []);
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível buscar os clientes. Tente novamente.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, value]);

  if (value) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3"
        data-testid="selected-customer"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <User className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{value.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[value.phone || value.mobile, value.document].filter(Boolean).join(' · ') || 'Sem contato cadastrado'}
            </p>
          </div>
        </div>
        {!disabled && (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
            Trocar
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="customer-search">Buscar cliente</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id="customer-search"
            className="pl-9"
            placeholder="Nome, telefone ou documento"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={disabled}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="rounded-lg border border-border" aria-live="polite">
        {loading ? (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Buscando clientes...
          </p>
        ) : error ? (
          <p className="p-4 text-sm text-danger">{error}</p>
        ) : results.length === 0 ? (
          <div className="space-y-3 p-4 text-sm text-muted-foreground">
            <p>{debounced ? `Nenhum cliente encontrado para “${debounced}”.` : 'Nenhum cliente cadastrado.'}</p>
            <Link
              href="/dashboard/customers/new"
              className="inline-flex items-center gap-2 font-medium text-foreground underline underline-offset-4"
            >
              <UserPlus className="h-4 w-4" aria-hidden /> Cadastrar novo cliente
            </Link>
          </div>
        ) : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto" role="listbox" aria-label="Clientes encontrados">
            {results.map((customer) => (
              <li key={customer.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => onChange(customer)}
                  disabled={disabled}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{customer.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[customer.phone || customer.mobile, customer.document].filter(Boolean).join(' · ') || 'Sem contato'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
