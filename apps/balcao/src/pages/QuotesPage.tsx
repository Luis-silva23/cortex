import { useState } from 'react';
import { Link } from 'react-router-dom';
import { listQuotes } from '../api/endpoints';
import { formatBRL } from '../lib/money';
import { QUOTE_STATUS_LABEL, label, quoteTone } from '../lib/labels';
import { AsyncBlock, Badge, Button, Card, inputClass, useAsync } from '../components/ui';

/** Orçamentos recentes da filial (para retomar um atendimento): lista paginada pelo servidor, com filtro de situação. */
export default function QuotesPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const state = useAsync(() => listQuotes({ status: status || undefined, page, limit: 20 }), [status, page]);

  return (
    <Card
      title="Orçamentos"
      action={
        <select className={`${inputClass} w-auto py-1`} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filtrar por situação">
          <option value="">Todas as situações</option>
          {Object.entries(QUOTE_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      }
    >
      <AsyncBlock state={state} isEmpty={(d) => d.quotes.length === 0} empty="Nenhum orçamento nesta situação.">
        {(d) => (
          <>
            <ul className="divide-y divide-primary-100">
              {d.quotes.map((q) => (
                <li key={q.id}>
                  <Link to={`/orcamentos/${q.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-primary-50">
                    <span>
                      <strong>#{q.quoteNumber}</strong> · {q.customer?.name ?? ''} · {q.motorcycle ? `${q.motorcycle.brand} ${q.motorcycle.model}` : ''}
                    </span>
                    <span className="flex items-center gap-2">
                      {formatBRL(q.versions[q.versions.length - 1]?.totalAmount)}
                      <Badge tone={quoteTone(q.status)}>{label(QUOTE_STATUS_LABEL, q.status)}</Badge>
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
