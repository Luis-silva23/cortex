'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { centralApi, apiErrorMessage, type AlertAction } from '@/lib/api';
import { LoadingState } from '../_components/states';
import { ALERT_STATUS_LABEL, ALERT_STATUS_STYLE, CATEGORY_LABEL, EVENT_LABEL, SEVERITY_LABEL, fmtAgo, fmtDateTime } from '../_central/format';
import { InlineError, Kpi, Pill } from '../_central/ui';

// Central de alertas: lista com filtros e o ciclo de tratamento. Cada ação grava um evento imutável no backend (quem, quando, o quê) e é validada contra o estado atual.
const ACTIONS_BY_STATUS: Record<string, Array<{ action: AlertAction; label: string; needsNote?: boolean }>> = {
  OPEN: [
    { action: 'ACKNOWLEDGE', label: 'Reconhecer' },
    { action: 'START', label: 'Iniciar tratamento' },
    { action: 'RESOLVE', label: 'Resolver', needsNote: true },
  ],
  ACKNOWLEDGED: [
    { action: 'START', label: 'Iniciar tratamento' },
    { action: 'RESOLVE', label: 'Resolver', needsNote: true },
  ],
  IN_PROGRESS: [{ action: 'RESOLVE', label: 'Resolver', needsNote: true }],
  RESOLVED: [{ action: 'REOPEN', label: 'Reabrir' }],
};

function AlertCenter() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const companyId = params.get('companyId') ?? '';
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(params.get('id'));
  const [detail, setDetail] = useState<any>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<Array<{ id: string; name: string }>>([]);
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    try {
      const res = await centralApi.alerts({ status, severity, category, scope, q: debouncedQ, companyId, page, limit: 20 });
      setData(res.data);
      setError(null);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar os alertas.'));
    } finally {
      setLoading(false);
    }
  }, [status, severity, category, scope, debouncedQ, companyId, page]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    void centralApi.assignees().then((r) => setAssignees(r.data.assignees ?? [])).catch(() => setAssignees([]));
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setDetailError(null);
    setNote('');
    try {
      const res = await centralApi.alert(id);
      setDetail(res.data);
      setAssignee(res.data.assignedTo ?? '');
    } catch (err: any) {
      setDetailError(apiErrorMessage(err?.response?.data, 'Não foi possível abrir o alerta.'));
    }
  }, []);

  useEffect(() => {
    if (openId) void openDetail(openId);
    // abre uma vez para o id da URL; as demais aberturas chamam openDetail direto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    setOpenId(null);
    setDetail(null);
    if (params.get('id')) router.replace(companyId ? `/dashboard/observability/alertas?companyId=${companyId}` : '/dashboard/observability/alertas');
  };

  const act = async (action: AlertAction, extra: { note?: string; assigneeId?: string | null } = {}) => {
    if (!detail) return;
    setBusy(true);
    setDetailError(null);
    try {
      const res = await centralApi.alertAction(detail.id, { action, ...extra });
      setDetail(res.data);
      setAssignee(res.data.assignedTo ?? '');
      setNote('');
      void load();
    } catch (err: any) {
      setDetailError(apiErrorMessage(err?.response?.data, 'A ação não foi aplicada.'));
    } finally {
      setBusy(false);
    }
  };

  const summary = data?.summary;
  const available = detail ? (ACTIONS_BY_STATUS[detail.status] ?? []) : [];

  return (
    <div className="space-y-6" data-testid="alert-center">
      <div>
        <h2 className="text-lg font-semibold">Central de alertas</h2>
        <p className="text-sm text-muted-foreground">Alertas da plataforma e das empresas, com reconhecimento, responsável, tratamento e histórico. Um problema repetido reabre o mesmo alerta, sem duplicar.</p>
      </div>

      {summary && (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo">
          <Kpi testId="alerts-open" title="Abertos" value={summary.open} />
          <Kpi testId="alerts-unhandled" title="Sem tratamento" value={summary.unhandled} hint="ainda não reconhecidos nem em tratamento" status={summary.unhandled > 0 ? 'ATTENTION' : 'NORMAL'} />
          <Kpi testId="alerts-critical" title="Críticos ou fora do ar" value={(summary.bySeverity.CRITICAL ?? 0) + (summary.bySeverity.OFFLINE ?? 0)} status={(summary.bySeverity.CRITICAL ?? 0) + (summary.bySeverity.OFFLINE ?? 0) > 0 ? 'CRITICAL' : 'NORMAL'} />
          <Kpi testId="alerts-attention" title="Em atenção" value={summary.bySeverity.ATTENTION ?? 0} status={(summary.bySeverity.ATTENTION ?? 0) > 0 ? 'ATTENTION' : 'NORMAL'} />
        </section>
      )}

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs text-muted-foreground">
            Estado
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} data-testid="filter-status" className="mt-1">
              <option value="">Todos</option>
              {Object.entries(ALERT_STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Gravidade
            <Select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} data-testid="filter-severity" className="mt-1">
              <option value="">Todas</option>
              {Object.entries(SEVERITY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Categoria
            <Select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} data-testid="filter-category" className="mt-1">
              <option value="">Todas</option>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Alvo
            <Select value={scope} onChange={(e) => { setScope(e.target.value); setPage(1); }} data-testid="filter-scope" className="mt-1">
              <option value="">Plataforma e empresas</option>
              <option value="central">Só infraestrutura central</option>
              <option value="company">Só empresas</option>
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Buscar
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tipo ou detalhe" data-testid="filter-q" className="mt-1" />
          </label>
          {companyId && (
            <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-5">
              Filtrando por uma empresa. <Link href="/dashboard/observability/alertas" className="underline">Limpar</Link>
            </p>
          )}
        </CardContent>
      </Card>

      {error && <InlineError message={error} onRetry={load} />}
      {loading && !data ? (
        <LoadingState label="Carregando alertas..." />
      ) : (
        data && (
          <Card>
            <CardContent className="p-0">
              {data.items.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground" data-testid="alerts-empty">Nenhum alerta com estes filtros.</p>
              ) : (
                <div className="overflow-x-auto p-4">
                  <table className="w-full text-sm" data-testid="alerts-table">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Início</th>
                        <th className="py-2 pr-3 font-medium">Categoria</th>
                        <th className="py-2 pr-3 font-medium">Alvo</th>
                        <th className="py-2 pr-3 font-medium">Gravidade</th>
                        <th className="py-2 pr-3 font-medium">Estado</th>
                        <th className="py-2 pr-3 font-medium">Responsável</th>
                        <th className="py-2 pr-3 font-medium">Ocorrências</th>
                        <th className="py-2 font-medium">Detalhe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((a: any) => (
                        <tr key={a.id} className="border-b last:border-0" data-testid={`alert-row-${a.id}`}>
                          <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(a.startedAt)}</td>
                          <td className="py-2 pr-3">
                            <button type="button" className="underline" onClick={() => void openDetail(a.id)} data-testid={`alert-open-${a.id}`}>
                              {CATEGORY_LABEL[a.category] ?? a.category}
                            </button>
                          </td>
                          <td className="py-2 pr-3">{a.companyName ?? 'Infraestrutura central'}</td>
                          <td className="py-2 pr-3">{SEVERITY_LABEL[a.severity] ?? a.severity}</td>
                          <td className="py-2 pr-3">
                            <Pill className={ALERT_STATUS_STYLE[a.status]}>{ALERT_STATUS_LABEL[a.status] ?? a.status}</Pill>
                          </td>
                          <td className="py-2 pr-3">{a.assignedToName ?? '—'}</td>
                          <td className="py-2 pr-3 tabular-nums">{a.occurrences}</td>
                          <td className="py-2 text-muted-foreground">{a.detail ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Pagination page={data.page} pages={Math.max(1, Math.ceil(data.total / data.limit))} total={data.total} itemCount={data.items.length} onPageChange={setPage} itemLabel="alertas" />
              {data.capped && <p className="px-4 pb-3 text-xs text-muted-foreground">A lista mostra os 1.000 alertas mais recentes dos filtros escolhidos; refine os filtros para ver os demais.</p>}
            </CardContent>
          </Card>
        )
      )}

      <Dialog open={openId !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="alert-dialog">
          <DialogHeader>
            <DialogTitle>{detail ? `${CATEGORY_LABEL[detail.category] ?? detail.category} — ${detail.type}` : 'Alerta'}</DialogTitle>
            <DialogDescription>{detail ? `${detail.companyName ?? 'Infraestrutura central'} · ${SEVERITY_LABEL[detail.severity] ?? detail.severity} · desde ${fmtDateTime(detail.startedAt)} (${fmtAgo(detail.startedAt)})` : 'Carregando…'}</DialogDescription>
          </DialogHeader>
          {detailError && <InlineError message={detailError} />}
          {!detail && !detailError && <LoadingState label="Carregando o alerta..." />}
          {detail && (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Pill className={ALERT_STATUS_STYLE[detail.status]} testId="alert-status">{ALERT_STATUS_LABEL[detail.status] ?? detail.status}</Pill>
                <span className="text-xs text-muted-foreground">{detail.occurrences} ocorrência(s) · última {fmtAgo(detail.lastSeenAt)} · responsável: {detail.assignedToName ?? 'ninguém'}</span>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">O que foi medido</p>
                <p>{detail.detail ?? '—'}</p>
                {detail.evidence && detail.evidence !== detail.detail && <p className="text-xs text-muted-foreground">Evidência: {detail.evidence}</p>}
              </div>
              {detail.guidance && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Orientação de diagnóstico</p>
                  <p data-testid="alert-guidance">{detail.guidance}</p>
                </div>
              )}
              {detail.resolutionNote && (
                <p className="text-xs text-muted-foreground">Resolvido como: {detail.resolutionNote}</p>
              )}

              <div className="space-y-2 rounded-md border p-3" data-testid="alert-actions">
                <label className="block text-xs text-muted-foreground">
                  Anotação (obrigatória para resolver e para anotar)
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} className="mt-1" data-testid="alert-note" />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {available.map((a) => (
                    <Button key={a.action} type="button" size="sm" variant={a.action === 'RESOLVE' ? 'default' : 'outline'} disabled={busy || (a.needsNote && note.trim().length < 3)} onClick={() => void act(a.action, { note })} data-testid={`action-${a.action}`}>
                      {a.label}
                    </Button>
                  ))}
                  <Button type="button" size="sm" variant="ghost" disabled={busy || note.trim().length < 3} onClick={() => void act('NOTE', { note })} data-testid="action-NOTE">
                    Anotar
                  </Button>
                </div>
                {detail.status !== 'RESOLVED' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="h-9 w-56" aria-label="Responsável" data-testid="assignee-select">
                      <option value="">Sem responsável</option>
                      {assignees.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </Select>
                    <Button type="button" size="sm" variant="outline" disabled={busy || assignee === (detail.assignedTo ?? '')} onClick={() => void act('ASSIGN', { assigneeId: assignee || null, note })} data-testid="action-ASSIGN">
                      Definir responsável
                    </Button>
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Histórico (imutável)</p>
                <ol className="space-y-1" data-testid="alert-history">
                  {detail.events.map((e: any) => (
                    <li key={e.id} className="flex flex-wrap gap-x-2 text-xs">
                      <span className="text-muted-foreground">{fmtDateTime(e.createdAt)}</span>
                      <span className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</span>
                      <span className="text-muted-foreground">por {e.actorName ?? '—'}</span>
                      {e.note && <span>— {e.note}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AlertCenterPage() {
  return (
    <Suspense fallback={<LoadingState label="Carregando a central de alertas..." />}>
      <AlertCenter />
    </Suspense>
  );
}
