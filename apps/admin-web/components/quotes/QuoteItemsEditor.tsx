'use client';

import { useEffect, useState } from 'react';
import { Loader2, Package, Plus, Search, Trash2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useDebounce } from '@/lib/hooks/useDebounce';
import {
  ITEM_TYPE_LABEL,
  formatCurrency,
  lineTotal,
  newItemDraft,
  type QuoteItemDraft,
  type QuoteItemType,
} from '@/lib/quotes';

interface ProductOption {
  id: string;
  name: string;
  sku?: string | null;
  salePrice?: number | string | null;
}

interface QuoteItemsEditorProps {
  items: QuoteItemDraft[];
  onChange: (items: QuoteItemDraft[]) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}

function toNumber(raw: string): number {
  const parsed = Number(String(raw).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function ProductSearch({ onPick, onClose }: { onPick: (product: ProductOption) => void; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [results, setResults] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getProducts({ search: debounced || undefined, limit: 8 })
      .then((res) => {
        if (!cancelled) setResults(res?.products ?? []);
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível buscar produtos.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3" data-testid="product-search">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            className="pl-9"
            placeholder="Buscar peça por nome ou SKU"
            aria-label="Buscar peça no catálogo"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Fechar
        </Button>
      </div>

      <div aria-live="polite">
        {loading ? (
          <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Buscando...
          </p>
        ) : error ? (
          <p className="p-2 text-sm text-danger">{error}</p>
        ) : results.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">Nenhum produto encontrado. Você pode digitar a peça manualmente.</p>
        ) : (
          <ul className="max-h-52 divide-y divide-border overflow-y-auto rounded-md border border-border bg-card">
            {results.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => onPick(product)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{product.name}</span>
                    {product.sku && <span className="block truncate text-xs text-muted-foreground">SKU {product.sku}</span>}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-foreground">{formatCurrency(product.salePrice)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function QuoteItemsEditor({ items, onChange, errors = {}, disabled }: QuoteItemsEditorProps) {
  const [searchingKey, setSearchingKey] = useState<string | null>(null);

  const update = (key: string, patch: Partial<QuoteItemDraft>) =>
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const remove = (key: string) => {
    onChange(items.filter((item) => item.key !== key));
    if (searchingKey === key) setSearchingKey(null);
  };

  const add = (type: QuoteItemType) => onChange([...items, newItemDraft(type)]);

  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="no-items">
          Nenhum item ainda. Adicione os serviços de mão de obra e as peças do orçamento.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item, index) => {
            const total = lineTotal(toNumber(item.quantity), toNumber(item.unitPrice));
            const error = errors[item.key];
            const rowId = `item-${item.key}`;
            return (
              <li
                key={item.key}
                data-testid="quote-item-row"
                className="rounded-lg border border-border bg-card p-4"
                aria-invalid={error ? true : undefined}
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                  <div className="space-y-1 md:col-span-2">
                    <Label htmlFor={`${rowId}-type`}>Tipo</Label>
                    <Select
                      id={`${rowId}-type`}
                      value={item.itemType}
                      disabled={disabled}
                      onChange={(e) => {
                        const itemType = e.target.value as QuoteItemType;
                        // Serviço não referencia produto do catálogo.
                        update(item.key, { itemType, ...(itemType === 'SERVICE' ? { productId: undefined } : {}) });
                        if (itemType === 'SERVICE' && searchingKey === item.key) setSearchingKey(null);
                      }}
                    >
                      <option value="SERVICE">{ITEM_TYPE_LABEL.SERVICE}</option>
                      <option value="PART">{ITEM_TYPE_LABEL.PART}</option>
                    </Select>
                  </div>

                  <div className="space-y-1 md:col-span-4">
                    <Label htmlFor={`${rowId}-description`}>Descrição</Label>
                    <Input
                      id={`${rowId}-description`}
                      value={item.description}
                      disabled={disabled}
                      placeholder={item.itemType === 'SERVICE' ? 'Ex.: Troca de óleo' : 'Ex.: Filtro de óleo'}
                      onChange={(e) => update(item.key, { description: e.target.value })}
                    />
                    {item.itemType === 'PART' && (
                      <div className="flex items-center gap-2 pt-1">
                        {item.productId ? (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Package className="h-3.5 w-3.5" aria-hidden /> Produto do catálogo
                          </span>
                        ) : null}
                        {!disabled && (
                          <button
                            type="button"
                            className="text-xs font-medium text-foreground underline underline-offset-4"
                            onClick={() => setSearchingKey(searchingKey === item.key ? null : item.key)}
                          >
                            {item.productId ? 'Trocar peça' : 'Buscar no catálogo'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <Label htmlFor={`${rowId}-quantity`}>Quantidade</Label>
                    <Input
                      id={`${rowId}-quantity`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={item.quantity}
                      disabled={disabled}
                      onChange={(e) => update(item.key, { quantity: e.target.value })}
                    />
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <Label htmlFor={`${rowId}-price`}>Valor unitário</Label>
                    <Input
                      id={`${rowId}-price`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={item.unitPrice}
                      disabled={disabled}
                      placeholder="0,00"
                      onChange={(e) => update(item.key, { unitPrice: e.target.value })}
                    />
                  </div>

                  <div className="flex items-end justify-between gap-2 md:col-span-2">
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-none text-foreground">Total</p>
                      <p className="h-10 py-2 text-sm font-semibold tabular-nums text-foreground" data-testid="item-total">
                        {formatCurrency(total)}
                      </p>
                    </div>
                    {!disabled && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remover item ${index + 1}`}
                        onClick={() => remove(item.key)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                </div>

                {searchingKey === item.key && (
                  <ProductSearch
                    onClose={() => setSearchingKey(null)}
                    onPick={(product) => {
                      update(item.key, {
                        productId: product.id,
                        description: product.name,
                        unitPrice: product.salePrice != null ? String(Number(product.salePrice)) : item.unitPrice,
                      });
                      setSearchingKey(null);
                    }}
                  />
                )}

                {error && (
                  <p className="mt-3 text-sm text-danger" role="alert">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => add('SERVICE')}>
            <Wrench className="mr-2 h-4 w-4" aria-hidden /> Adicionar serviço
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => add('PART')}>
            <Plus className="mr-2 h-4 w-4" aria-hidden /> Adicionar peça
          </Button>
        </div>
      )}
    </div>
  );
}
