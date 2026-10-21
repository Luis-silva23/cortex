'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Archive, CheckSquare, FileText, Plus, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { QuoteStatusBadge } from '@/components/quotes/QuoteStatusBadge';
import { getCurrentUserClaims } from '@/lib/api';
import { quotesApi, type QuoteCloseResponse } from '@/lib/api/quotes';
import { getApiErrorMessage } from '@/lib/errors';
import { cn } from '@/lib/cn';
import {
  CLOSE_OUTCOME_LABEL,
  CLOSE_REASON_MIN,
  QUOTE_STATUSES,
  QUOTE_STATUS_LABEL,
  canWriteQuotes,
  formatCurrency,
  formatDate,
  isClosable,
  isPastValidity,
  overdueLabel,
} from '@/lib/quotes';

const PAGE_SIZE = 20;

// KPIs = contagem por status (neutros: número em cor de texto normal). Cada
// um filtra a lista ao clicar — "Aprovados" é o que espera virar OS.
const KPI_STATUSES = ['DRAFT', 'SENT', 'APPROVED', 'CONVERTED'] as const;
const KPI_HINT: Record<(typeof KPI_STATUSES)[number], string> = {
  DRAFT: 'ainda não enviados',
  SENT: 'aguardando o cliente',
  APPROVED: 'prontos para virar OS',
  CONVERTED: 'já geraram OS',
};

interface QuoteRow {
  id: string;
  quoteNumber: number;
  status: string;
  validUntil?: string | null;
  createdAt: string;
  overdue?: boolean;
  daysWithoutResponse?: number | null;
  respondBy?: string | null;
  customer?: { id: string; name: string } | null;
  motorcycle?: { brand: string; model: string; licensePlate?: string | null } | null;
  versions?: Array<{ versionNumber: number; totalAmount: number | string }>;
}

export default function QuotesPage() {
  const [canWrite, setCanWrite] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [page, setPage] = useState(1);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kpis, setKpis] = useState<Record<string, number | null>>({});
  const [kpiLoading, setKpiLoading] = useState(true);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeResult, setCloseResult] = useState<QuoteCloseResponse | null>(null);

  useEffect(() => {
    setCanWrite(canWriteQuotes(getCurrentUserClaims()?.userType));
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await quotesApi.list({ status: statusFilter || undefined, overdue: onlyOverdue, page, limit: PAGE_SIZE });
      setQuotes(result.quotes ?? []);
      setPagination({
        page: result.pagination?.page ?? page,
        pages: result.pagination?.pages ?? 1,
        total: result.pagination?.total ?? 0,
      });
    } catch (err) {
      console.error('Erro ao carregar orçamentos:', err);
      setError('Não foi possível carregar os orçamentos. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, onlyOverdue, page]);

  const loadKpis = useCallback(async () => {
    setKpiLoading(true);
    const results = await Promise.allSettled([
      ...KPI_STATUSES.map((status) => quotesApi.list({ status, limit: 1 })),
      quotesApi.list({ overdue: true, limit: 1 }),
    ]);
    const next: Record<string, number | null> = {};
    [...KPI_STATUSES, 'OVERDUE'].forEach((key, index) => {
      const result = results[index];
      next[key] = result.status === 'fulfilled' ? (result.value?.pagination?.total ?? 0) : null;
    });
    setKpis(next);
    setKpiLoading(false);
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    loadKpis();
  }, [loadKpis]);

  const applyFilter = (status: string, overdue = false) => {
    setStatusFilter(status);
    setOnlyOverdue(overdue);
    setPage(1);
  };

  const closableVisible = useMemo(() => quotes.filter(isClosable), [quotes]);
  const overdueVisible = useMemo(() => quotes.filter((q) => q.overdue), [quotes]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectOverdue = () => setSelected(new Set(overdueVisible.map((q) => q.id)));
  const allClosableSelected = closableVisible.length > 0 && closableVisible.every((q) => selected.has(q.id));
  const toggleAll = () => setSelected(allClosableSelected ? new Set() : new Set(closableVisible.map((q) => q.id)));

  function openClose() {
    setCloseReason('');
    setCloseError(null);
    setCloseResult(null);
    setCloseOpen(true);
  }

  async function submitClose() {
    if (closeReason.trim().length < CLOSE_REASON_MIN) {
      setCloseError(`Informe o motivo (mínimo ${CLOSE_REASON_MIN} caracteres).`);
      return;
    }
    setClosing(true);
    setCloseError(null);
    try {
      const result = await quotesApi.close([...selected], closeReason.trim());
      setCloseResult(result);
      setSelected(new Set());
      await Promise.all([loadList(), loadKpis()]);
    } catch (err) {
      setCloseError(getApiErrorMessage(err, 'Não foi possível encerrar os orçamentos.'));
    } finally {
      setClosing(false);
    }
  }

  const kpiCards: Array<{ key: string; label: string; hint: string; active: boolean; onClick: () => void }> = [
    ...KPI_STATUSES.map((status) => ({
      key: status,
      label: QUOTE_STATUS_LABEL[status],
      hint: KPI_HINT[status],
      active: statusFilter === status && !onlyOverdue,
      onClick: () => (statusFilter === status && !onlyOverdue ? applyFilter('') : applyFilter(status)),
    })),
    {
      key: 'OVERDUE',
      label: 'Vencidos',
      hint: 'sem resposta no prazo',
      active: onlyOverdue,
      onClick: () => (onlyOverdue ? applyFilter('') : applyFilter('', true)),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Orçamentos</h1>
          <p className="mt-1 text-muted-foreground">
            Orçamento → Aguardando aprovação → Aprovado → Ordem de Serviço. Sem resposta no prazo, o orçamento vence e pode ser encerrado.
          </p>
        </div>
        {canWrite && (
          <Link href="/dashboard/quotes/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Novo orçamento
            </Button>
          </Link>
        )}
      </div>

      <section aria-label="Resumo por status" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {kpiCards.map((kpi) => (
          <button
            key={kpi.key}
            type="button"
            onClick={kpi.onClick}
            aria-pressed={kpi.active}
            data-testid={`kpi-${kpi.key}`}
            className={cn(
              'rounded-lg border bg-card p-4 text-left shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              kpi.active ? 'border-foreground' : 'border-border'
            )}
          >
            <p className="text-sm font-medium text-muted-foreground">{kpi.label}</p>
            {kpiLoading ? (
              <div className="mt-2 h-8 w-12 animate-pulse rounded bg-muted" />
            ) : (
              <p className="mt-1 text-3xl font-bold tabular-nums text-foreground">{kpis[kpi.key] ?? '—'}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{kpi.hint}</p>
          </button>
        ))}
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full sm:w-64">
            <Select aria-label="Filtrar por status" value={statusFilter} onChange={(e) => applyFilter(e.target.value, onlyOverdue)}>
              <option value="">Todos os status</option>
              {QUOTE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {QUOTE_STATUS_LABEL[status]}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={onlyOverdue}
              onChange={(e) => applyFilter(statusFilter, e.target.checked)}
              data-testid="filter-overdue"
            />
            Somente vencidos
          </label>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={selectOverdue} disabled={overdueVisible.length === 0} data-testid="select-overdue">
              <CheckSquare className="mr-2 h-4 w-4" aria-hidden />
              Selecionar vencidos{overdueVisible.length ? ` (${overdueVisible.length})` : ''}
            </Button>
            <Button onClick={openClose} disabled={selected.size === 0} data-testid="close-selected">
              <Archive className="mr-2 h-4 w-4" aria-hidden />
              Encerrar selecionados{selected.size ? ` (${selected.size})` : ''}
            </Button>
          </div>
        )}
      </div>

      <Card>
        {loading ? (
          <div className="space-y-3 p-6" role="status" aria-label="Carregando orçamentos">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : error ? (
          <CardContent className="p-12 text-center">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" aria-hidden />
            <p className="mb-4 text-muted-foreground" role="alert">
              {error}
            </p>
            <Button variant="outline" onClick={loadList}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
              Tentar novamente
            </Button>
          </CardContent>
        ) : quotes.length === 0 ? (
          <CardContent className="p-12 text-center" data-testid="quotes-empty">
            <FileText className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden />
            <h3 className="mb-2 text-lg font-medium text-foreground">
              {statusFilter || onlyOverdue ? 'Nenhum orçamento com este filtro' : 'Nenhum orçamento ainda'}
            </h3>
            <p className="mb-4 text-muted-foreground">
              {statusFilter || onlyOverdue ? 'Ajuste o filtro para ver outros orçamentos.' : 'Crie o primeiro orçamento para um cliente e o veículo dele.'}
            </p>
            {statusFilter || onlyOverdue ? (
              <Button variant="outline" onClick={() => applyFilter('')}>
                Limpar filtro
              </Button>
            ) : (
              canWrite && (
                <Link href="/dashboard/quotes/new">
                  <Button>
                    <Plus className="mr-2 h-4 w-4" aria-hidden />
                    Novo orçamento
                  </Button>
                </Link>
              )
            )}
          </CardContent>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  {canWrite && (
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        aria-label="Selecionar todos os encerráveis da página"
                        checked={allClosableSelected}
                        disabled={closableVisible.length === 0}
                        onChange={toggleAll}
                      />
                    </TableHead>
                  )}
                  <TableHead>Nº</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead className="hidden md:table-cell">Moto</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Validade</TableHead>
                  <TableHead className="hidden lg:table-cell">Criado em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quotes.map((quote) => {
                  const pastValidity = isPastValidity(quote);
                  const closable = isClosable(quote);
                  const overdueText = overdueLabel(quote);
                  return (
                    <TableRow key={quote.id} data-testid="quote-row" data-overdue={quote.overdue ? 'true' : 'false'}>
                      {canWrite && (
                        <TableCell>
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            aria-label={`Selecionar orçamento #${quote.quoteNumber}`}
                            checked={selected.has(quote.id)}
                            disabled={!closable && !selected.has(quote.id)}
                            title={closable ? undefined : 'Só rascunhos e orçamentos vencidos podem ser encerrados'}
                            onChange={() => toggle(quote.id)}
                            data-testid={`select-${quote.quoteNumber}`}
                          />
                        </TableCell>
                      )}
                      <TableCell className="font-medium">
                        <Link href={`/dashboard/quotes/${quote.id}`} className="text-foreground underline-offset-4 hover:underline">
                          #{quote.quoteNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{quote.customer?.name ?? '—'}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {quote.motorcycle
                          ? `${quote.motorcycle.brand} ${quote.motorcycle.model}${quote.motorcycle.licensePlate ? ` · ${quote.motorcycle.licensePlate}` : ''}`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {quote.versions?.[0] ? formatCurrency(quote.versions[0].totalAmount) : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <QuoteStatusBadge status={quote.status} />
                          {overdueText && (
                            <span className="text-xs font-medium text-warning" data-testid="overdue-label">
                              {overdueText}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <span className={cn(pastValidity && 'text-warning')}>
                          {formatDate(quote.validUntil)}
                          {pastValidity && <span className="ml-2 text-xs font-medium">validade passou</span>}
                        </span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">{formatDate(quote.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Pagination
              page={pagination.page}
              pages={pagination.pages}
              total={pagination.total}
              itemCount={quotes.length}
              onPageChange={setPage}
              itemLabel="orçamentos"
            />
          </>
        )}
      </Card>

      <Dialog open={closeOpen} onOpenChange={(open) => !closing && setCloseOpen(open)}>
        <DialogContent className="max-w-lg" onClose={() => !closing && setCloseOpen(false)}>
          <DialogHeader>
            <DialogTitle>{closeResult ? 'Resultado do encerramento' : `Encerrar ${selected.size} orçamento(s)`}</DialogTitle>
            <DialogDescription>
              {closeResult
                ? `${closeResult.summary.closed} encerrado(s), ${closeResult.summary.alreadyClosed} já encerrado(s), ${closeResult.summary.notAllowed} não permitido(s), ${closeResult.summary.notFound} não encontrado(s).`
                : 'O orçamento encerrado sai da fila de aprovação, mas o histórico fica guardado e ele pode ser reaberto se o cliente voltar.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-6">
            {closeResult ? (
              <ul className="max-h-72 space-y-2 overflow-y-auto" data-testid="close-results">
                {closeResult.results.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-2 text-sm" data-outcome={r.outcome}>
                    <span className="font-medium text-foreground">{r.quoteNumber ? `#${r.quoteNumber}` : r.id}</span>
                    <span className="text-right">
                      <span className={cn('font-medium', r.outcome === 'CLOSED' ? 'text-success' : r.outcome === 'NOT_ALLOWED' ? 'text-warning' : 'text-muted-foreground')}>
                        {CLOSE_OUTCOME_LABEL[r.outcome] ?? r.outcome}
                      </span>
                      {r.outcome !== 'CLOSED' && <span className="block text-xs text-muted-foreground">{r.message}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="close-reason">Motivo do encerramento</Label>
                <Textarea
                  id="close-reason"
                  rows={3}
                  value={closeReason}
                  onChange={(e) => setCloseReason(e.target.value)}
                  placeholder="Ex.: cliente não respondeu no prazo"
                />
              </div>
            )}
            {closeError && (
              <Alert variant="destructive" data-testid="close-error">
                <AlertTitle>Não foi possível encerrar</AlertTitle>
                <AlertDescription>{closeError}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            {closeResult ? (
              <Button onClick={() => setCloseOpen(false)} data-testid="close-done">
                Fechar
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setCloseOpen(false)} disabled={closing}>
                  Voltar
                </Button>
                <Button onClick={submitClose} disabled={closing} data-testid="close-confirm">
                  {closing ? 'Encerrando...' : 'Encerrar selecionados'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
