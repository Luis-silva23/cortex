'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { BarCompareChart, type BarRow } from '@/components/charts/BarCompareChart';
import { FunnelChart } from '@/components/charts/FunnelChart';
import { centralApi, apiErrorMessage } from '@/lib/api';
import { LoadingState } from '../_components/states';
import { fmtDateTime, fmtInt } from '../_central/format';
import { ChartCard, Definition, Freshness, InlineError, Kpi, Notice, Pill } from '../_central/ui';

const STAGES: Array<{ key: string; label: string }> = [
  { key: 'INTERESTED', label: 'Interessado' },
  { key: 'DEMO', label: 'Demonstração' },
  { key: 'PROPOSAL', label: 'Proposta' },
  { key: 'ONBOARDING', label: 'Implantação' },
  { key: 'ACTIVE', label: 'Cliente ativo' },
  { key: 'SUSPENDED', label: 'Suspenso' },
  { key: 'CANCELLED', label: 'Cancelado' },
];
const SERIES = [
  { key: 'newCompaniesPerMonth', label: 'Novas empresas (cadastro real)', note: 'medido a partir do cadastro de empresas' },
  { key: 'newLeadsPerMonth', label: 'Novas oportunidades', note: 'a partir do início do registro comercial' },
  { key: 'activationsPerMonth', label: 'Ativações (chegaram a Cliente ativo)', note: 'a partir do início do registro comercial' },
  { key: 'cancellationsPerMonth', label: 'Cancelamentos', note: 'a partir do início do registro comercial' },
  { key: 'suspensionsPerMonth', label: 'Suspensões', note: 'a partir do início do registro comercial' },
] as const;

export default function FunnelPage() {
  const [funnel, setFunnel] = useState<any>(null);
  const [leads, setLeads] = useState<any>(null);
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stageFilter, setStageFilter] = useState('');
  const [page, setPage] = useState(1);
  const [serie, setSerie] = useState<(typeof SERIES)[number]['key']>('newCompaniesPerMonth');
  const [form, setForm] = useState({ name: '', contact: '', source: '', stage: 'INTERESTED' });
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [linkTo, setLinkTo] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, l] = await Promise.all([centralApi.funnel(), centralApi.leads({ stage: stageFilter, page, limit: 10 })]);
      setFunnel(f.data);
      setLeads(l.data);
      setError(null);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar o funil.'));
    } finally {
      setLoading(false);
    }
  }, [stageFilter, page]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    void centralApi.companies({ limit: 50, sort: 'name' }).then((r) => setCompanies((r.data.items ?? []).map((c: any) => ({ id: c.id, name: c.name })))).catch(() => setCompanies([]));
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setFormError(null);
    try {
      await fn();
      await load();
    } catch (err: any) {
      setFormError(apiErrorMessage(err?.response?.data, 'A operação não foi aplicada.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !funnel) return <LoadingState label="Carregando o funil..." />;
  if (!funnel) return <InlineError message={error ?? 'Sem dados.'} onRetry={load} />;

  const stages = funnel.stages.filter((s: any) => s.funnel);
  const terminal = funnel.stages.filter((s: any) => !s.funnel);
  const serieDef = SERIES.find((s) => s.key === serie)!;
  const rows: BarRow[] = (funnel.evolution[serie] as Array<{ month: string; count: number }>).map((m) => ({ id: m.month, label: m.month, value: m.count }));

  return (
    <div className="space-y-6" data-testid="funnel-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Funil de clientes e implantação</h2>
          <p className="text-sm text-muted-foreground">Da primeira conversa ao cliente ativo, suspensão e cancelamento. Só existe o que foi registrado: nada de histórico comercial é inventado.</p>
        </div>
        <Freshness generatedAt={funnel.generatedAt} onRefresh={load} />
      </div>

      {error && <InlineError message={error} onRetry={load} />}
      {funnel.coverage.notes.map((n: string) => (
        <Notice key={n} testId="funnel-note">{n}</Notice>
      ))}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo">
        <Kpi testId="funnel-leads" title="Oportunidades registradas" value={fmtInt(funnel.totals.leads)} hint={`${fmtInt(funnel.totals.events)} mudanças de etapa no histórico`} definition={funnel.definition} />
        <Kpi testId="funnel-companies" title="Empresas no cadastro" value={fmtInt(funnel.coverage.companiesTotal)} hint={`${funnel.coverage.companiesLinkedToLeads} vinculadas a uma oportunidade · ${funnel.coverage.companiesWithoutLead} sem histórico de aquisição`} />
        <Kpi testId="funnel-onboarding" title="Empresas ativas em implantação" value={fmtInt(funnel.companies.onboarding)} hint={`${funnel.stuckOnboarding.companies.length} paradas há mais de ${funnel.stuckOnboarding.thresholdDays} dias`} status={funnel.stuckOnboarding.companies.length > 0 ? 'ATTENTION' : 'NORMAL'} />
        <Kpi testId="funnel-active" title="Clientes ativos" value={fmtInt(funnel.companies.active)} hint={`${funnel.companies.suspended} suspensas`} />
      </section>

      <ChartCard testId="funnel-chart" title="Funil" unit="oportunidades que chegaram a cada etapa" definition={funnel.definition}>
        <FunnelChart stages={stages} conversions={funnel.conversions} testId="funnel-visual" />
        <p className="mt-3 text-xs text-muted-foreground" data-testid="funnel-terminal">
          Fora do funil: {terminal.map((t: any) => `${t.label} ${t.current} agora`).join(' · ')}.
        </p>
      </ChartCard>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          testId="funnel-evolution"
          title="Evolução mensal"
          unit="quantidade por mês (UTC)"
          subtitle={serieDef.note}
          right={
            <Select value={serie} onChange={(e) => setSerie(e.target.value as typeof serie)} className="h-9 w-64" aria-label="Série mensal" data-testid="evolution-select">
              {SERIES.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </Select>
          }
        >
          <BarCompareChart rows={rows} title={serieDef.label} unit="por mês" formatValue={(v) => `${v}`} layout="vertical" height={240} />
          {rows.length === 0 && <p className="mt-2 text-xs text-muted-foreground">Sem registros nesta série: indicador que só pode ser calculado depois do início da coleta.</p>}
        </ChartCard>

        <Card data-testid="funnel-stuck">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Implantação parada</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">{funnel.stuckOnboarding.note}</p>
            {funnel.stuckOnboarding.companies.length === 0 ? (
              <p className="text-muted-foreground">Nenhuma empresa ativa parada em implantação.</p>
            ) : (
              <ul className="divide-y">
                {funnel.stuckOnboarding.companies.map((c: any) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={`/dashboard/observability/empresas/${c.id}`} className="underline">{c.name}</Link>
                    <span className="text-xs text-muted-foreground">{c.days} dias · falta: {c.missing.join(' e ')}</span>
                  </li>
                ))}
              </ul>
            )}
            {funnel.stuckOnboarding.leads.length > 0 && <p className="text-xs text-muted-foreground">{funnel.stuckOnboarding.leads.length} oportunidade(s) em Implantação há mais de {funnel.stuckOnboarding.thresholdDays} dias.</p>}
          </CardContent>
        </Card>
      </section>

      <Card data-testid="leads-card">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Oportunidades</CardTitle>
            <Select value={stageFilter} onChange={(e) => { setStageFilter(e.target.value); setPage(1); }} className="h-9 w-48" aria-label="Filtrar por etapa" data-testid="leads-stage-filter">
              <option value="">Todas as etapas</option>
              {STAGES.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="grid gap-2 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-5"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await centralApi.createLead({ name: form.name, contact: form.contact || undefined, source: form.source || undefined, stage: form.stage });
                setForm({ name: '', contact: '', source: '', stage: 'INTERESTED' });
              });
            }}
            data-testid="lead-form"
          >
            <label className="text-xs text-muted-foreground lg:col-span-2">
              Nome da oportunidade
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={120} className="mt-1" data-testid="lead-name" />
            </label>
            <label className="text-xs text-muted-foreground">
              Contato (opcional)
              <Input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} maxLength={200} className="mt-1" />
            </label>
            <label className="text-xs text-muted-foreground">
              Origem (opcional)
              <Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} maxLength={80} className="mt-1" />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[9.5rem] flex-1 text-xs text-muted-foreground">
                Etapa inicial
                <Select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} className="mt-1" data-testid="lead-stage">
                  {STAGES.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </Select>
              </label>
              <Button type="submit" disabled={busy || form.name.trim().length < 2} data-testid="lead-submit">Registrar</Button>
            </div>
          </form>
          {formError && <InlineError message={formError} />}

          {leads && leads.items.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground" data-testid="leads-empty">Nenhuma oportunidade registrada{stageFilter ? ' nesta etapa' : ''}.</p>
          ) : (
            leads && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="leads-table">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Oportunidade</th>
                      <th className="py-2 pr-3 font-medium">Etapa</th>
                      <th className="py-2 pr-3 font-medium">Na etapa desde</th>
                      <th className="py-2 pr-3 font-medium">Empresa vinculada</th>
                      <th className="py-2 font-medium">Mover / vincular</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.items.map((l: any) => {
                      const target = moveTo[l.id] ?? '';
                      const needsReason = target === 'CANCELLED' || target === 'SUSPENDED';
                      return (
                        <tr key={l.id} className="border-b align-top last:border-0" data-testid={`lead-row-${l.id}`}>
                          <td className="py-2 pr-3">
                            <p className="font-medium">{l.name}</p>
                            <p className="text-xs text-muted-foreground">{[l.source, l.contact].filter(Boolean).join(' · ') || '—'}</p>
                          </td>
                          <td className="py-2 pr-3"><Pill className="bg-muted text-foreground border-border">{l.stageLabel}</Pill>{l.closedReason && <p className="mt-1 text-xs text-muted-foreground">{l.closedReason}</p>}</td>
                          <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(l.stageEnteredAt)}</td>
                          <td className="py-2 pr-3">{l.company ? <Link className="underline" href={`/dashboard/observability/empresas/${l.company.id}`}>{l.company.name}</Link> : '—'}</td>
                          <td className="py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Select value={target} onChange={(e) => setMoveTo({ ...moveTo, [l.id]: e.target.value })} className="h-9 w-40" aria-label={`Mover ${l.name}`} data-testid={`lead-move-${l.id}`}>
                                <option value="">Mover para…</option>
                                {STAGES.filter((s) => s.key !== l.stage).map((s) => (
                                  <option key={s.key} value={s.key}>{s.label}</option>
                                ))}
                              </Select>
                              {needsReason && <Input value={reason[l.id] ?? ''} onChange={(e) => setReason({ ...reason, [l.id]: e.target.value })} placeholder="Motivo" className="h-9 w-40" aria-label="Motivo" />}
                              <Button type="button" size="sm" variant="outline" disabled={busy || !target || (needsReason && (reason[l.id] ?? '').trim().length < 3)} onClick={() => void run(async () => { await centralApi.moveLead(l.id, target, reason[l.id]); setMoveTo({ ...moveTo, [l.id]: '' }); })} data-testid={`lead-move-btn-${l.id}`}>
                                Mover
                              </Button>
                            </div>
                            {!l.company && (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <Select value={linkTo[l.id] ?? ''} onChange={(e) => setLinkTo({ ...linkTo, [l.id]: e.target.value })} className="h-9 w-52" aria-label={`Vincular ${l.name} a uma empresa`}>
                                  <option value="">Vincular à empresa…</option>
                                  {companies.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                  ))}
                                </Select>
                                <Button type="button" size="sm" variant="ghost" disabled={busy || !linkTo[l.id]} onClick={() => void run(async () => { await centralApi.linkLead(l.id, linkTo[l.id]); })}>
                                  Vincular
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
          {leads && <Pagination page={leads.page} pages={Math.max(1, Math.ceil(leads.total / leads.limit))} total={leads.total} itemCount={leads.items.length} onPageChange={setPage} itemLabel="oportunidades" />}
          <Definition text={funnel.definition} label="Como o funil é calculado" />
        </CardContent>
      </Card>
    </div>
  );
}
