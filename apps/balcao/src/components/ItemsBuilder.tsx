import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { getAvailability, searchProducts } from '../api/endpoints';
import { toApiError } from '../api/http';
import type { Availability, Product } from '../api/types';
import { formatBRL, formatQuantity, parseInputNumber } from '../lib/money';
import type { Line } from '../lib/quote-lines';
import { previewTotal } from '../lib/quote-preview';
import { canSearch } from '../lib/search';
import { Badge, Button, ErrorBox, inputClass, Spinner } from './ui';

/**
 * Montagem dos itens do orçamento (peças do catálogo e serviços). O preço da peça é o do catálogo e o disponível vem do servidor;
 * o total mostrado aqui é uma PRÉVIA — o oficial é calculado e gravado pelo servidor ao salvar.
 */
export default function ItemsBuilder({ lines, onChange, branchId }: { lines: Line[]; onChange: (lines: Line[]) => void; branchId: string | null }) {
  const [tab, setTab] = useState<'PART' | 'SERVICE'>('PART');
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<Product[]>([]);
  const [avail, setAvail] = useState<Record<string, Availability>>({});
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [svc, setSvc] = useState({ description: '', price: '' });

  useEffect(() => {
    if (tab !== 'PART' || !canSearch(term)) {
      setFound([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const { products } = await searchProducts(term.trim(), 8);
        if (cancelled) return;
        setFound(products);
        if (products.length > 0 && branchId) {
          const items = await getAvailability(products.map((p) => p.id), branchId);
          if (!cancelled) setAvail(Object.fromEntries(items.map((a) => [a.productId, a])));
        }
      } catch (e) {
        if (!cancelled) setError(toApiError(e).message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, tab, branchId]);

  const addPart = (p: Product) => {
    const existing = lines.find((l) => l.productId === p.id);
    if (existing) {
      onChange(lines.map((l) => (l === existing ? { ...l, quantity: String((parseInputNumber(l.quantity) ?? 0) + 1) } : l)));
    } else {
      onChange([...lines, { key: `p-${p.id}-${Date.now()}`, itemType: 'PART', productId: p.id, description: p.name, quantity: '1', unitPrice: String(p.salePrice) }]);
    }
    setTerm('');
    setFound([]);
  };

  const addService = () => {
    const price = parseInputNumber(svc.price);
    if (!svc.description.trim() || price === null || price <= 0) return setError('Informe a descrição e um valor maior que zero para o serviço.');
    setError(null);
    onChange([...lines, { key: `s-${Date.now()}`, itemType: 'SERVICE', description: svc.description.trim(), quantity: '1', unitPrice: svc.price }]);
    setSvc({ description: '', price: '' });
  };

  const update = (key: string, patch: Partial<Line>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="tablist">
        {(['PART', 'SERVICE'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={clsx('rounded-lg px-3 py-1.5 text-sm font-semibold', tab === t ? 'bg-primary-600 text-white' : 'bg-primary-100 text-primary-600')}>
            {t === 'PART' ? 'Peça' : 'Serviço'}
          </button>
        ))}
      </div>

      {tab === 'PART' ? (
        <div>
          <input className={inputClass} placeholder="Buscar peça por nome, código ou marca" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Buscar peça" />
          {searching && <Spinner label="Buscando…" />}
          {found.length > 0 && (
            <ul className="mt-2 divide-y divide-primary-100 rounded-lg border border-primary-200 bg-white">
              {found.map((p) => {
                const a = avail[p.id];
                return (
                  <li key={p.id}>
                    <button type="button" onClick={() => addPart(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-primary-50">
                      <span>
                        <span className="font-medium">{p.name}</span> <span className="text-xs text-gray-500">{p.sku}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        {formatBRL(p.salePrice)}
                        {a && <Badge tone={a.available > 0 ? 'success' : 'danger'}>{a.available > 0 ? `${formatQuantity(a.available)} disp.` : 'Sem estoque'}</Badge>}
                        <Plus className="h-4 w-4" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
          <input className={inputClass} placeholder="Descrição do serviço" value={svc.description} onChange={(e) => setSvc({ ...svc, description: e.target.value })} aria-label="Descrição do serviço" />
          <input className={inputClass} placeholder="Valor" inputMode="decimal" value={svc.price} onChange={(e) => setSvc({ ...svc, price: e.target.value })} aria-label="Valor do serviço" />
          <Button type="button" variant="secondary" onClick={addService}>
            <Plus className="h-4 w-4" /> Adicionar
          </Button>
        </div>
      )}
      {error && <ErrorBox message={error} />}

      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-primary-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-primary-50 text-left text-xs uppercase text-primary-500">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="w-24 px-3 py-2">Qtd.</th>
                <th className="px-3 py-2 text-right">Unitário</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-100">
              {lines.map((l) => (
                <tr key={l.key}>
                  <td className="px-3 py-2">
                    {l.description} <Badge>{l.itemType === 'PART' ? 'Peça' : 'Serviço'}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <input className={`${inputClass} py-1`} inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} aria-label={`Quantidade de ${l.description}`} />
                  </td>
                  <td className="px-3 py-2 text-right">{formatBRL(l.unitPrice)}</td>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => onChange(lines.filter((x) => x.key !== l.key))} aria-label={`Remover ${l.description}`} className="text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-primary-50 font-semibold">
                <td className="px-3 py-2" colSpan={2}>
                  Prévia do total <span className="font-normal text-gray-500">(o valor oficial é calculado pelo servidor ao salvar)</span>
                </td>
                <td className="px-3 py-2 text-right">
                  {formatBRL(previewTotal(lines.map((l) => ({ quantity: parseInputNumber(l.quantity) ?? 0, unitPrice: parseInputNumber(l.unitPrice) ?? 0 }))))}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
