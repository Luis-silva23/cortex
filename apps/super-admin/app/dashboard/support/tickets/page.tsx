'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { supportAdminApi, type SupportTicketListParams } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, EmptyState, ErrorState, LoadingState, PageTitle } from '../_components/states';
import { useSupportAgents, useSupportCatalog } from '../_lib/hooks';
import { errorText, formatDateTime, formatRelative, priorityBadgeClass, priorityLabel, statusBadgeClass, statusLabel } from '../_lib/format';
import type { Pagination, SupportCompany, SupportTicketRow } from '../_lib/types';

const PAGE_SIZE = 25;

interface Filters {
  status: string;
  q: string;
  companyId: string;
  module: string;
  type: string;
  priority: string;
  assignedToId: string;
  from: string; // AAAA-MM-DD (dia local)
  to: string;
}

const FILTER_KEYS: (keyof Filters)[] = ['status', 'q', 'companyId', 'module', 'type', 'priority', 'assignedToId', 'from', 'to'];
const DEFAULT_FILTERS: Filters = { status: 'open', q: '', companyId: '', module: '', type: '', priority: '', assignedToId: '', from: '', to: '' };

function readFilters(sp: URLSearchParams): Filters {
  const f = { ...DEFAULT_FILTERS };
  FILTER_KEYS.forEach((k) => {
    const v = sp.get(k);
    if (v !== null) f[k] = v;
  });
  return f;
}

/** Dia local → instante ISO (início do dia em "de", fim do dia em "até"). */
function dayToIso(day: string, endOfDay: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number);
  const date = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export default function SupportTicketsPage() {
  return (
    <Suspense fallback={<LoadingState label="Carregando chamados..." />}>
      <TicketsView />
    </Suspense>
  );
}

function TicketsView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const spKey = searchParams.toString();
  const applied = useMemo(() => readFilters(new URLSearchParams(spKey)), [spKey]);
  const page = Math.max(1, Number.parseInt(new URLSearchParams(spKey).get('page') || '1', 10) || 1);

  const [draft, setDraft] = useState<Filters>(applied);
  const [rows, setRows] = useState<SupportTicketRow[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [companies, setCompanies] = useState<SupportCompany[]>([]);
  const { catalog } = useSupportCatalog();
  const { agents } = useSupportAgents();

  useEffect(() => setDraft(applied), [applied]);

  useEffect(() => {
    supportAdminApi
      .companies()
      .then((res) => setCompanies(res.data))
      .catch(() => setCompanies([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: SupportTicketListParams = { page, limit: PAGE_SIZE, status: applied.status || 'all' };
      if (applied.q.trim()) params.q = applied.q.trim();
      if (applied.companyId) params.companyId = applied.companyId;
      if (applied.module) params.module = applied.module;
      if (applied.type) params.type = applied.type;
      if (applied.priority) params.priority = applied.priority;
      if (applied.assignedToId) params.assignedToId = applied.assignedToId;
      const from = dayToIso(applied.from, false);
      const to = dayToIso(applied.to, true);
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await supportAdminApi.tickets(params);
      setRows(res.data.data);
      setPagination(res.data.pagination);
    } catch (err) {
      setError(errorText(err, 'Não foi possível carregar os chamados.'));
    } finally {
      setLoading(false);
    }
  }, [applied, page]);

  useEffect(() => {
    load();
  }, [load]);

  function pushQuery(f: Filters, p: number) {
    const sp = new URLSearchParams();
    FILTER_KEYS.forEach((k) => {
      const v = f[k].trim();
      if (k === 'status') {
        if (v !== DEFAULT_FILTERS.status) sp.set('status', v || 'all');
      } else if (v) sp.set(k, v);
    });
    if (p > 1) sp.set('page', String(p));
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const applyFilters = (e?: React.FormEvent) => {
    e?.preventDefault();
    pushQuery(draft, 1);
  };
  const clearFilters = () => pushQuery(DEFAULT_FILTERS, 1);
  const set = (k: keyof Filters) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const hasExtraFilters = FILTER_KEYS.some((k) => k !== 'status' && applied[k]);

  return (
    <div className="space-y-4">
      <PageTitle
        title="Chamados"
        description="Filtre a fila de atendimento. Os filtros ficam no endereço da página — dá para compartilhar o link."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
            Atualizar
          </Button>
        }
      />

      <Card>
        <CardContent className="p-4">
          <form onSubmit={applyFilters} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="ticket-filters">
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs" htmlFor="f-q">Buscar por número ou assunto</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="f-q" className="h-9 pl-9 text-sm" placeholder="Ex.: 1042 ou impressora" value={draft.q} onChange={(e) => set('q')(e.target.value)} data-testid="ticket-filter-q" />
              </div>
            </div>
            <Field label="Situação" id="f-status">
              <Select id="f-status" className="h-9 text-sm" value={draft.status} onChange={(e) => set('status')(e.target.value)} data-testid="ticket-filter-status">
                <option value="open">Em aberto</option>
                <option value="all">Todas</option>
                {(catalog?.statuses ?? []).map((s) => (
                  <option key={s.value} value={s.value}>
                    {statusLabel(s.value, catalog)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Empresa" id="f-company">
              <Select id="f-company" className="h-9 text-sm" value={draft.companyId} onChange={(e) => set('companyId')(e.target.value)}>
                <option value="">Todas</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.tickets})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Módulo" id="f-module">
              <Select id="f-module" className="h-9 text-sm" value={draft.module} onChange={(e) => set('module')(e.target.value)}>
                <option value="">Todos</option>
                {(catalog?.modules ?? []).map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tipo" id="f-type">
              <Select id="f-type" className="h-9 text-sm" value={draft.type} onChange={(e) => set('type')(e.target.value)}>
                <option value="">Todos</option>
                {(catalog?.types ?? []).map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Prioridade" id="f-priority">
              <Select id="f-priority" className="h-9 text-sm" value={draft.priority} onChange={(e) => set('priority')(e.target.value)}>
                <option value="">Todas</option>
                {(catalog?.priorities ?? []).map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Responsável" id="f-assignee">
              <Select id="f-assignee" className="h-9 text-sm" value={draft.assignedToId} onChange={(e) => set('assignedToId')(e.target.value)}>
                <option value="">Qualquer um</option>
                <option value="unassigned">Sem responsável</option>
                {(agents ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Aberto de" id="f-from">
              <Input id="f-from" type="date" className="h-9 text-sm" value={draft.from} onChange={(e) => set('from')(e.target.value)} />
            </Field>
            <Field label="Aberto até" id="f-to">
              <Input id="f-to" type="date" className="h-9 text-sm" value={draft.to} onChange={(e) => set('to')(e.target.value)} />
            </Field>
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-2">
              <Button type="submit" size="sm" data-testid="ticket-filter-apply">
                Filtrar
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={clearFilters}>
                Limpar
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {loading && !rows ? (
        <LoadingState label="Carregando chamados..." />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState
          message={
            hasExtraFilters || applied.status !== 'open'
              ? 'Nenhum chamado encontrado com esses filtros.'
              : 'Nenhum chamado em aberto. A fila está em dia.'
          }
        >
          {(hasExtraFilters || applied.status !== 'open') && (
            <Button size="sm" variant="outline" onClick={clearFilters}>
              Limpar filtros
            </Button>
          )}
        </EmptyState>
      ) : (
        <Card className={cn(loading && 'opacity-60 transition-opacity')} aria-busy={loading}>
          {/* Telas largas: tabela. Telefone: cartões empilhados (sem rolagem horizontal da página). */}
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm" data-testid="ticket-table">
              <thead className="border-b bg-muted/50 text-left text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Assunto</th>
                  <th className="px-3 py-2 font-medium">Empresa / filial</th>
                  <th className="px-3 py-2 font-medium">Módulo</th>
                  <th className="px-3 py-2 font-medium">Tipo</th>
                  <th className="px-3 py-2 font-medium">Prioridade</th>
                  <th className="px-3 py-2 font-medium">Situação</th>
                  <th className="px-3 py-2 font-medium">Responsável</th>
                  <th className="px-3 py-2 font-medium">Última atividade</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr
                    key={t.id}
                    data-testid="ticket-row"
                    data-ticket-number={t.ticketNumber}
                    data-unread={t.unreadForSupport ? 'true' : 'false'}
                    className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                    onClick={() => router.push(`/dashboard/support/tickets/${t.id}`)}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <UnreadDot unread={t.unreadForSupport} />#{t.ticketNumber}
                      </span>
                    </td>
                    <td className="max-w-[18rem] px-3 py-2">
                      <Link href={`/dashboard/support/tickets/${t.id}`} className={cn('line-clamp-2 hover:underline', t.unreadForSupport && 'font-semibold')} onClick={(e) => e.stopPropagation()}>
                        {t.subject}
                      </Link>
                    </td>
                    <td className="max-w-[12rem] px-3 py-2">
                      <p className="truncate">{t.company?.name}</p>
                      {t.branch && <p className="truncate text-xs text-muted-foreground">{t.branch.name}</p>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{t.moduleLabel}</td>
                    <td className="whitespace-nowrap px-3 py-2">{t.typeLabel}</td>
                    <td className="px-3 py-2">
                      <Badge className={priorityBadgeClass(t.priority)}>{priorityLabel(t.priority, catalog)}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge className={statusBadgeClass(t.status)}>{statusLabel(t.status, catalog)}</Badge>
                    </td>
                    <td className="max-w-[10rem] truncate px-3 py-2">{t.assignedTo?.name ?? <span className="text-muted-foreground">Sem responsável</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground" title={formatDateTime(t.lastMessageAt)}>
                      {formatRelative(t.lastMessageAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="divide-y lg:hidden">
            {rows.map((t) => (
              <li key={t.id} data-testid="ticket-card" data-ticket-number={t.ticketNumber}>
                <Link href={`/dashboard/support/tickets/${t.id}`} className="block space-y-2 p-4 hover:bg-accent/50">
                  <div className="flex items-start justify-between gap-2">
                    <p className={cn('min-w-0 break-words text-sm', t.unreadForSupport && 'font-semibold')}>
                      <span className="mr-1 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                        <UnreadDot unread={t.unreadForSupport} />#{t.ticketNumber}
                      </span>
                      {t.subject}
                    </p>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(t.lastMessageAt)}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {t.company?.name}
                    {t.branch ? ` · ${t.branch.name}` : ''} · {t.moduleLabel} · {t.typeLabel}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className={statusBadgeClass(t.status)}>{statusLabel(t.status, catalog)}</Badge>
                    <Badge className={priorityBadgeClass(t.priority)}>{priorityLabel(t.priority, catalog)}</Badge>
                    <span className="text-xs text-muted-foreground">{t.assignedTo?.name ?? 'Sem responsável'}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {pagination && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4 text-sm">
              <p className="text-muted-foreground">
                {pagination.total} chamado(s){pagination.pages > 1 && ` · página ${pagination.page} de ${pagination.pages}`}
              </p>
              {pagination.pages > 1 && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => pushQuery(applied, page - 1)}>
                    Anterior
                  </Button>
                  <Button size="sm" variant="outline" disabled={page >= pagination.pages || loading} onClick={() => pushQuery(applied, page + 1)}>
                    Próxima
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function UnreadDot({ unread }: { unread: boolean }) {
  if (!unread) return null;
  return (
    <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-foreground" title="Mensagem nova do cliente" data-testid="ticket-unread">
      <span className="sr-only">Mensagem nova do cliente</span>
    </span>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      {children}
    </div>
  );
}
