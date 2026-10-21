import { Link, useParams } from 'react-router-dom';
import { FilePlus } from 'lucide-react';
import { getMotorcycle, listQuotes, listServiceOrders } from '../api/endpoints';
import { useAuthStore } from '../store/auth.store';
import { canWrite } from '../lib/permissions';
import { formatBRL, toNumber } from '../lib/money';
import { OS_STATUS_LABEL, QUOTE_STATUS_LABEL, label, osTone, quoteTone } from '../lib/labels';
import { AsyncBlock, Badge, Card, useAsync } from '../components/ui';

/** Histórico do veículo: dados, ordens de serviço e orçamentos (os do cliente que são deste veículo). */
export default function VehiclePage() {
  const { id = '' } = useParams();
  const user = useAuthStore((s) => s.user);
  const bike = useAsync(() => getMotorcycle(id), [id]);
  const orders = useAsync(() => listServiceOrders({ motorcycleId: id, limit: 30 }), [id]);
  const customerId = bike.data?.customerId;
  const quotes = useAsync(async () => {
    if (!customerId) return { quotes: [], pagination: { page: 1, limit: 0, total: 0 } };
    const all = await listQuotes({ customerId, limit: 50 });
    return { ...all, quotes: all.quotes.filter((q) => q.motorcycle?.id === id) };
  }, [id, customerId]);

  return (
    <>
      <AsyncBlock state={bike}>
        {(m) => (
          <Card
            title="Veículo"
            action={
              canWrite(user?.userType) && (
                <Link to={`/orcamentos/novo?customerId=${m.customerId}&motorcycleId=${m.id}`} className="flex items-center gap-1 text-sm font-semibold text-primary-500 hover:underline">
                  <FilePlus className="h-4 w-4" /> Novo orçamento
                </Link>
              )
            }
          >
            <h1 className="text-xl font-bold">
              {m.brand} {m.model} {m.year ? `· ${m.year}` : ''}
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              {m.licensePlate ?? 'sem placa'}
              {m.color ? ` · ${m.color}` : ''}
              {m.kilometerReading != null ? ` · ${toNumber(m.kilometerReading).toLocaleString('pt-BR')} km` : ''}
            </p>
            {m.customer && (
              <p className="mt-2 text-sm">
                Proprietário:{' '}
                <Link to={`/clientes/${m.customer.id}`} className="font-semibold text-primary-500 hover:underline">
                  {m.customer.name}
                </Link>
              </p>
            )}
          </Card>
        )}
      </AsyncBlock>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ordens de serviço">
          <AsyncBlock state={orders} isEmpty={(d) => d.orders.length === 0} empty="Nenhuma OS para este veículo.">
            {(d) => (
              <ul className="divide-y divide-primary-100">
                {d.orders.map((o) => (
                  <li key={o.id}>
                    <Link to={`/os/${o.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-primary-50">
                      <span>
                        OS #{o.osNumber} · {o.entryDate ? new Date(o.entryDate).toLocaleDateString('pt-BR') : ''}
                      </span>
                      <span className="flex items-center gap-2">
                        {formatBRL(o.finalTotal)} <Badge tone={osTone(o.status)}>{label(OS_STATUS_LABEL, o.status)}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AsyncBlock>
        </Card>

        <Card title="Orçamentos">
          <AsyncBlock state={quotes} isEmpty={(d) => d.quotes.length === 0} empty="Nenhum orçamento para este veículo.">
            {(d) => (
              <ul className="divide-y divide-primary-100">
                {d.quotes.map((q) => (
                  <li key={q.id}>
                    <Link to={`/orcamentos/${q.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-primary-50">
                      <span>#{q.quoteNumber}</span>
                      <span className="flex items-center gap-2">
                        {formatBRL(q.versions[q.versions.length - 1]?.totalAmount)}
                        <Badge tone={quoteTone(q.status)}>{label(QUOTE_STATUS_LABEL, q.status)}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AsyncBlock>
        </Card>
      </div>
    </>
  );
}
