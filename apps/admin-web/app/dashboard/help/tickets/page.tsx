'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Inbox, Plus, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { HelpTabs } from '@/components/support/HelpTabs';
import { getCurrentUserClaims } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { clampPage } from '@/lib/list-pagination';
import { supportApi, type TicketSummary } from '@/lib/api/support';
import { NEW_TICKET_PATH, SUPPORT_STATUS_VARIANT, TICKET_FILTERS } from '@/lib/support';

const PAGE_SIZE = 20;

/**
 * Meus chamados. Quem abriu vê os próprios; quem tem `support:view_company` (administração) vê os da empresa — ou da
 * filial, se o usuário for de uma filial. A API decide o escopo; a tela só informa qual é.
 */
export default function MyTicketsPage() {
  const [rows, setRows] = useState<TicketSummary[]>([]);
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{ page: number; pages: number; total: number } | null>(null);
  const [companyWide, setCompanyWide] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [platformUser, setPlatformUser] = useState(false);

  useEffect(() => {
    setPlatformUser(getCurrentUserClaims()?.userType === 'SUPER_ADMIN');
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setTerm(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await supportApi.list({ status, ...(term ? { q: term } : {}), page, limit: PAGE_SIZE });
      const target = clampPage(page, r.pagination?.pages);
      if (target !== page) {
        setPage(target);
        return;
      }
      setRows(r.data);
      setPagination(r.pagination);
      setCompanyWide(r.companyWide);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar os chamados. Tente novamente.'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (platformUser) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, term, page, platformUser]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Ajuda e Suporte</h1>
          <p className="mt-1 text-muted-foreground">
            {companyWide ? 'Chamados abertos pela sua equipe (conforme a sua permissão).' : 'Os chamados que você abriu.'}
          </p>
        </div>
        <Link href={NEW_TICKET_PATH}>
          <Button tabIndex={-1}>
            <Plus className="mr-2 h-4 w-4" aria-hidden /> Novo chamado
          </Button>
        </Link>
      </div>
      <HelpTabs />

      {platformUser ? (
        <Card className="p-8 text-center text-muted-foreground">A equipe CÓRTEX acompanha os chamados pelo Console de Suporte (Super Admin).</Card>
      ) : (
        <Card>
          <div className="space-y-3 border-b border-border p-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por situação">
              {TICKET_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  data-testid={`ticket-filter-${f.value}`}
                  aria-pressed={status === f.value}
                  onClick={() => {
                    setStatus(f.value);
                    setPage(1);
                  }}
                  className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                    status === f.value ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <label htmlFor="ticket-search" className="sr-only">
                Buscar por número ou assunto
              </label>
              <Input id="ticket-search" className="pl-9" placeholder="Número ou assunto" value={q} onChange={(e) => setQ(e.target.value)} maxLength={120} />
            </div>
          </div>

          {loading ? (
            <div className="p-12 text-center text-muted-foreground">Carregando…</div>
          ) : error ? (
            <div className="p-12 text-center">
              <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" aria-hidden />
              <p className="mb-4 text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={load}>
                Tentar novamente
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center">
              <Inbox className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden />
              <h3 className="mb-2 text-lg font-medium text-foreground">Nenhum chamado encontrado</h3>
              <p className="text-muted-foreground">{status !== 'all' || term ? 'Tente outro filtro ou outra busca.' : 'Quando precisar de ajuda, abra um chamado.'}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border" data-testid="ticket-list">
              {rows.map((t) => (
                <li key={t.id}>
                  <Link href={`/dashboard/help/tickets/${t.id}`} className="flex flex-col gap-1 p-4 transition-colors hover:bg-accent sm:flex-row sm:items-center sm:gap-4" data-testid="ticket-row">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {t.unread && <span className="h-2 w-2 rounded-full bg-foreground" aria-label="Nova resposta" title="Nova resposta" />}
                        <span className="text-sm text-muted-foreground">#{t.ticketNumber}</span>
                        <span className={`truncate text-foreground ${t.unread ? 'font-semibold' : 'font-medium'}`}>{t.subject}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t.moduleLabel} · {t.typeLabel}
                        {t.context?.label ? ` · ${t.context.label}` : ''}
                        {companyWide ? ` · ${t.requester.name}${t.branch?.name ? ` (${t.branch.name})` : ''}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant={SUPPORT_STATUS_VARIANT[t.status] ?? 'secondary'}>{t.statusLabel}</Badge>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">{new Date(t.lastMessageAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {!loading && !error && rows.length > 0 && (
            <Pagination
              page={pagination?.page ?? page}
              pages={pagination?.pages ?? 1}
              total={pagination?.total ?? rows.length}
              itemCount={rows.length}
              onPageChange={setPage}
              itemLabel="chamados"
            />
          )}
        </Card>
      )}
    </div>
  );
}
