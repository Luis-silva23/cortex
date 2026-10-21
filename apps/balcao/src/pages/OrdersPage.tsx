import { useState } from 'react';
import { Link } from 'react-router-dom';
import { listServiceOrders } from '../api/endpoints';
import { formatBRL } from '../lib/money';
import { OS_STATUS_LABEL, label, osTone } from '../lib/labels';
import { AsyncBlock, Badge, Button, Card, inputClass, useAsync } from '../components/ui';

/** Ordens de serviço da filial (consulta de acompanhamento): lista paginada pelo servidor, filtro por situação. */
export default function OrdersPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const state = useAsync(() => listServiceOrders({ status: status || undefined, page, limit: 20 }), [status, page]);

  return (
    <Card
      title="Ordens de serviço"
      action={
        <select className={`${inputClass} w-auto py-1`} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filtrar por situação">
          <option value="">Todas as situações</option>
          {Object.entries(OS_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      }
    >
      <AsyncBlock state={state} isEmpty={(d) => d.orders.length === 0} empty="Nenhuma OS nesta situação.">
        {(d) => (
          <>
            <ul className="divide-y divide-primary-100">
              {d.orders.map((o) => (
                <li key={o.id}>
                  <Link to={`/os/${o.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-primary-50">
                    <span>
                      <strong>OS #{o.osNumber}</strong> · {o.customer?.name ?? ''} · {o.motorcycle ? `${o.motorcycle.brand} ${o.motorcycle.model}` : ''}
                    </span>
                    <span className="flex items-center gap-2">
                      {formatBRL(o.finalTotal)}
                      <Badge tone={osTone(o.status)}>{label(OS_STATUS_LABEL, o.status)}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {(d.pagination?.pages ?? 1) > 1 && (
              <div className="mt-3 flex items-center justify-end gap-2 text-sm">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Anterior
                </Button>
                <span>
                  {page} / {d.pagination?.pages}
                </span>
                <Button variant="secondary" disabled={page >= (d.pagination?.pages ?? 1)} onClick={() => setPage((p) => p + 1)}>
                  Próxima
                </Button>
              </div>
            )}
          </>
        )}
      </AsyncBlock>
    </Card>
  );
}
