import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { getAvailability, searchProducts } from '../api/endpoints';
import { toApiError } from '../api/http';
import type { Availability, Product } from '../api/types';
import { useAuthStore } from '../store/auth.store';
import { needsBranchChoice } from '../lib/permissions';
import { canSearch } from '../lib/search';
import { formatBRL, formatQuantity } from '../lib/money';
import { Badge, Card, EmptyState, ErrorBox, inputClass, Spinner } from '../components/ui';

/**
 * Consulta de produto e DISPONÍVEL (saldo − reservas, calculado pelo servidor em /stock/availability). O Balcão não calcula
 * estoque e não mostra custo; mostra preço de venda e quanto pode ser vendido na filial da operação.
 */
export default function ProductsPage() {
  const { user, branchId } = useAuthStore();
  const [term, setTerm] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [availability, setAvailability] = useState<Record<string, Availability>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const blocked = !!user && needsBranchChoice(user) && !branchId;

  useEffect(() => {
    if (!canSearch(term)) {
      setProducts([]);
      setSearched(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const { products: found } = await searchProducts(term.trim(), 20);
        if (cancelled) return;
        setProducts(found);
        setSearched(true);
        if (!blocked && found.length > 0) {
          const items = await getAvailability(found.map((p) => p.id), branchId);
          if (!cancelled) setAvailability(Object.fromEntries(items.map((a) => [a.productId, a])));
        } else {
          setAvailability({});
        }
      } catch (e) {
        if (!cancelled) setError(toApiError(e).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, branchId, blocked]);

  return (
    <>
      <Card title="Produtos">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input autoFocus className={`${inputClass} pl-9 text-base`} placeholder="Nome, código, código de barras, marca ou aplicação" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Buscar produto" />
        </div>
        {blocked && <p className="mt-2 text-sm text-amber-700">Escolha a filial (no topo) para ver a disponibilidade.</p>}
      </Card>
      {loading && <Spinner label="Buscando…" />}
      {error && <ErrorBox message={error} />}
      {searched && !loading && products.length === 0 && <EmptyState>Nenhum produto para “{term}”.</EmptyState>}
      {products.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-primary-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-primary-50 text-left text-xs uppercase text-primary-500">
              <tr>
                <th className="px-3 py-2">Código</th>
                <th className="px-3 py-2">Produto</th>
                <th className="px-3 py-2">Local</th>
                <th className="px-3 py-2 text-right">Preço</th>
                <th className="px-3 py-2 text-right">Disponível</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-100">
              {products.map((p) => {
                const a = availability[p.id];
                return (
                  <tr key={p.id}>
                    <td className="px-3 py-2 font-mono text-xs">{p.sku}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-gray-500">{p.brand ?? ''}</div>
                    </td>
                    <td className="px-3 py-2 text-gray-600">{p.location ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{formatBRL(p.salePrice)}</td>
                    <td className="px-3 py-2 text-right">
                      {a ? (
                        <>
                          <Badge tone={a.available > 0 ? 'success' : 'danger'}>{a.available > 0 ? formatQuantity(a.available) : 'Sem estoque'}</Badge>
                          {a.reserved > 0 && <div className="text-xs text-gray-500">{formatQuantity(a.reserved)} reservado(s)</div>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
