'use client';

import { useEffect, useState } from 'react';
import { Loader2, Package, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useDebounce } from '@/lib/hooks/useDebounce';
import { formatCurrency } from '@/lib/quotes';

export interface ProductOption {
  id: string;
  name: string;
  sku?: string | null;
  // Decimal do Prisma chega como string no JSON — quem usa o preço deve
  // converter (ver parseDecimal em lib/service-orders.ts).
  salePrice?: number | string | null;
}

interface ProductPickerProps {
  value: ProductOption | null;
  onChange: (product: ProductOption | null) => void;
  disabled?: boolean;
  // Texto do campo de busca (quem usa pode adaptar: "peça", "produto"...).
  placeholder?: string;
  // Esconde o preço nos resultados (telas de estoque não precisam dele).
  showPrice?: boolean;
}

// Busca de produto no servidor (nome/SKU) no lugar de um <select> com todos os
// produtos: a API limita `limit` a 100 por página e ordena por nome, então numa
// loja com mais de 100 produtos a lista fixa nunca alcançava os demais. Mesmo
// padrão do ProductSearch de components/quotes/QuoteItemsEditor.tsx.
export function ProductPicker({
  value,
  onChange,
  disabled,
  placeholder = 'Buscar por nome ou SKU',
  showPrice = true,
}: ProductPickerProps) {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [results, setResults] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (value) return undefined;
    // `cancelled` evita que uma resposta antiga (de uma digitação anterior)
    // sobrescreva a mais recente quando chegam fora de ordem.
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getProducts({ search: debounced || undefined, limit: 8 })
      .then((res) => {
        if (!cancelled) setResults(res?.products ?? []);
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível buscar produtos. Tente novamente.');
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
        data-testid="selected-product"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Package className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{value.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[value.sku ? `SKU ${value.sku}` : null, showPrice && value.salePrice != null ? formatCurrency(value.salePrice) : null]
                .filter(Boolean)
                .join(' · ') || 'Produto do catálogo'}
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
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          className="pl-9"
          placeholder={placeholder}
          aria-label="Buscar produto no catálogo"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={disabled}
          autoComplete="off"
        />
      </div>

      <div className="rounded-lg border border-border" aria-live="polite">
        {loading ? (
          <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Buscando produtos...
          </p>
        ) : error ? (
          <p className="p-3 text-sm text-danger">{error}</p>
        ) : results.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {debounced ? `Nenhum produto encontrado para “${debounced}”.` : 'Nenhum produto cadastrado.'}
          </p>
        ) : (
          <ul className="max-h-52 divide-y divide-border overflow-y-auto">
            {results.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => onChange(product)}
                  disabled={disabled}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{product.name}</span>
                    {product.sku && (
                      <span className="block truncate text-xs text-muted-foreground">SKU {product.sku}</span>
                    )}
                  </span>
                  {showPrice && product.salePrice != null && (
                    <span className="shrink-0 text-sm tabular-nums text-foreground">
                      {formatCurrency(product.salePrice)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!loading && !error && results.length > 0 && !debounced && (
        <p className="text-xs text-muted-foreground">Mostrando os primeiros produtos — digite para refinar a busca.</p>
      )}
    </div>
  );
}
