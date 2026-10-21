'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { PercentGauge } from '@/components/charts/PercentGauge';
import { CHART_DANGER } from '@/lib/chart-theme';
import { centralApi, apiErrorMessage, type CentralRange } from '@/lib/api';
import { labelFormatter, tickFormatter } from '@/lib/chart-time';
import { LoadingState } from '../../_components/states';
import {
  ALERT_STATUS_LABEL,
  ALERT_STATUS_STYLE,
  CATEGORY_LABEL,
  INTEGRATION_STATE_LABEL,
  INTEGRATION_STATE_STYLE,
  LIFECYCLE_LABEL,
  MODULE_LABEL,
  SEVERITY_LABEL,
  USER_TYPE_LABEL,
  fmtAgo,
  fmtDateTime,
  fmtInt,
  fmtMs,
  fmtPct,
  healthPctStatus,
  isLongRange,
  RANGE_STEP_MS,
} from '../../_central/format';
import { ChartCard, Definition, Freshness, InlineError, Kpi, Notice, Pill, RangeSelector, StatusPill } from '../../_central/ui';

export default function CompanyMonitoringPage() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState<CentralRange>('24h');
  const [module, setModule] = useState('');
  const [severity, setSeverity] = useState('');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await centralApi.company(id, { range, module, severity });
      setData(res.data);
      setError(null);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar a empresa.'));
    } finally {
      setLoading(false);
    }
  }, [id, range, module, severity]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const stepMs = (data?.series.bucketSeconds ?? RANGE_STEP_MS[range] / 1000) * 1000;
  const common = { stepMs, formatTick: tickFormatter(isLongRange(range)), formatLabel: labelFormatter, singlePointPadMs: stepMs };
  const volume = useMemo(() => (data ? data.series.api.map((p: any) => ({ t: p.t, requests: p.requests })) : []), [data]);
  const latency = useMemo(() => (data ? data.series.api.map((p: any) => ({ t: p.t, p95: p.p95Ms })) : []), [data]);
  const errors = useMemo(() => (data ? data.series.api.map((p: any) => ({ t: p.t, pct: p.errorPct })) : []), [data]);

  if (loading && !data) return <LoadingState label="Carregando a empresa..." />;
  if (!data) return <InlineError message={error ?? 'Empresa não encontrada.'} onRetry={load} />;

  const c = data.company;
  const sum = data.integrations.summary;
  const u = data.usage;

  return (
    <div className="space-y-6" data-testid="company-monitoring">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/observability/empresas" aria-label="Voltar para a comparação de empresas" className="rounded-md border p-2 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h2 className="text-lg font-semibold" data-testid="company-name">
              {c.name}
            </h2>
            <p className="text-sm text-muted-foreground">
              <Pill className={c.lifecycle === 'ACTIVE' ? 'bg-success-soft text-success border-success/40' : c.lifecycle === 'ONBOARDING' ? 'bg-warning-soft text-warning border-warning/40' : 'bg-muted text-muted-foreground border-border'}>{LIFECYCLE_LABEL[c.lifecycle] ?? c.lifecycle}</Pill>
              <span className="ml-2">cadastrada em {fmtDateTime(c.createdAt)}{c.city ? ` · ${c.city}${c.state ? `/${c.state}` : ''}` : ''}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <RangeSelector value={range} onChange={setRange} />
          <Freshness generatedAt={data.generatedAt} onRefresh={load} />
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
          <label className="text-xs text-muted-foreground">
            Módulo (filtra utilização e gráficos pelas rotas do módulo)
            <Select value={module} onChange={(e) => setModule(e.target.value)} data-testid="filter-module" className="mt-1">
              <option value="">Todos os módulos</option>
              {Object.entries(MODULE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Gravidade dos alertas
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)} data-testid="filter-alert-severity" className="mt-1">
              <option value="">Todas</option>
              <option value="CRITICAL">Crítico</option>
              <option value="ATTENTION">Atenção</option>
              <option value="OFFLINE">Fora do ar</option>
            </Select>
          </label>
        </CardContent>
      </Card>

      {error && <InlineError message={error} onRetry={load} />}
      {data.filters.module && <Notice testId="module-filter-note">Filtro de módulo ativo: {MODULE_LABEL[data.filters.module]} — a utilização e os gráficos mostram só as rotas desse módulo (o módulo é inferido pelo prefixo da rota).</Notice>}

      <section aria-label="Utilização" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi testId="usage-requests" title="Requisições" value={fmtInt(u.requests)} hint={`${fmtInt(u.errors)} com erro 5xx (${fmtPct(u.errorPct)})`} />
        <Kpi testId="usage-p95" title="Latência p95" value={fmtMs(u.p95Ms)} hint="das requisições desta empresa no período" />
        <Kpi testId="usage-users" title="Usuários ativos no período" value={fmtInt(u.activeUsers)} hint={`último acesso de usuário: ${fmtAgo(u.lastLoginAt)}`} />
        <Kpi testId="usage-last" title="Última atividade" value={fmtAgo(u.lastActivityAt)} hint={`${fmtInt(u.sales)} vendas e ${fmtInt(u.serviceOrders)} ordens de serviço criadas no período (só contagem)`} />
      </section>
      <p className="text-xs text-muted-foreground">{u.note}</p>

      <section aria-label="Integrações" className="grid gap-4 lg:grid-cols-3" data-testid="integrations-section">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Saúde das integrações</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-3xl font-semibold tabular-nums" data-testid="integration-health">
              {sum.healthPct === null ? 'Sem dados' : fmtPct(sum.healthPct)}
            </p>
            <PercentGauge value={sum.healthPct} label="Verificadas e saudáveis" tone={sum.healthPct === null ? 'neutral' : sum.healthPct >= 90 ? 'good' : sum.healthPct >= 60 ? 'warn' : 'bad'} />
            <StatusPill status={healthPctStatus(sum.healthPct)} />
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>{sum.healthy} saudável(is) · {sum.degraded} degradada(s) · {sum.error} com erro</li>
              <li>{sum.notVerified} não verificada(s) · {sum.notConfigured} não configurada(s) · {sum.disabled} desativada(s)</li>
              <li>{sum.verified === 0 ? 'Nenhuma integração verificada: o percentual não pode ser calculado (e nunca vira 100%).' : `${sum.verified} integração(ões) entram na conta.`}</li>
            </ul>
            <Definition text={data.integrations.definition} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Integrações da empresa</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y" data-testid="integration-list">
              {data.integrations.items.map((i: any) => (
                <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`integration-${i.kind.toLowerCase()}`}>
                  <div>
                    <p className="text-sm font-medium">{i.label}</p>
                    <p className="text-xs text-muted-foreground">{i.reason}</p>
                  </div>
                  <Pill className={INTEGRATION_STATE_STYLE[i.state]}>{INTEGRATION_STATE_LABEL[i.state] ?? i.state}</Pill>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t pt-3 text-xs text-muted-foreground" data-testid="integration-errors">
              <p className="font-medium text-foreground">Erros por integração no período</p>
              {data.integrationErrors.logs.length === 0 ? <p>Nenhum erro de integração registrado nos logs do período.</p> : (
                <ul className="mt-1 space-y-0.5">
                  {data.integrationErrors.logs.map((l: any) => (
                    <li key={`${l.service}-${l.event}`}>{l.service} · {l.event}: {l.count} ocorrência(s), última {fmtAgo(l.lastAt)}</li>
                  ))}
                </ul>
              )}
              <p className="mt-1">Documentos fiscais por estado: {data.integrationErrors.fiscalDocumentsByStatus.length === 0 ? 'nenhum' : data.integrationErrors.fiscalDocumentsByStatus.map((f: any) => `${f.status} ${f.count}`).join(' · ')} · pagamentos recusados: {data.integrationErrors.paymentsRejected}</p>
              <p className="mt-1">{data.integrationErrors.note}</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Estrutura" className="grid gap-4 lg:grid-cols-2">
        <Card data-testid="structure-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Filiais e usuários</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">{data.structure.branches.length} filial(is)</p>
            <ul className="flex flex-wrap gap-2">
              {data.structure.branches.map((b: any) => (
                <li key={b.id}>
                  <Pill className={b.isActive ? 'bg-muted text-foreground border-border' : 'bg-muted text-muted-foreground border-border'}>{b.name}{b.isActive ? '' : ' (inativa)'}</Pill>
                </li>
              ))}
            </ul>
            <p className="pt-2 text-xs text-muted-foreground">Usuários ativos por tipo</p>
            <ul className="flex flex-wrap gap-2">
              {data.structure.usersByType.map((t: any) => (
                <li key={t.userType}>
                  <Pill className="bg-muted text-foreground border-border">{USER_TYPE_LABEL[t.userType] ?? t.userType}: {t.count}</Pill>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card data-testid="modules-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Módulos</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {data.modules.map((m: any) => (
                <li key={m.module}>
                  <Pill className={m.enabled ? 'bg-success-soft text-success border-success/40' : 'bg-muted text-muted-foreground border-border'}>
                    {MODULE_LABEL[m.module] ?? m.module}: {m.enabled ? 'habilitado' : 'desativado'}
                  </Pill>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">Habilitado = não desativado de forma explícita para a empresa (o módulo Canais nasce desativado e só liga por escolha).</p>
            <Link href={`/dashboard/companies/${id}/health`} className="mt-3 inline-block text-xs underline">
              Saúde por filial e equipamentos {data.health ? `(estado geral: ${data.health.status})` : ''}
            </Link>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Evolução" className="grid gap-4 lg:grid-cols-3">
        <ChartCard testId="company-chart-volume" title="Requisições" unit="por intervalo" subtitle={`período: ${range}${module ? ` · ${MODULE_LABEL[module]}` : ''}`}>
          {volume.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma requisição desta empresa no período{module ? ' para este módulo' : ''}.</p> : <TimeSeriesChart data={volume} title="Requisições" height={220} series={[{ key: 'requests', label: 'Requisições' }]} formatValue={(v) => v.toLocaleString('pt-BR')} formatAxis={(v) => v.toLocaleString('pt-BR')} {...common} />}
        </ChartCard>
        <ChartCard testId="company-chart-latency" title="Latência p95" unit="milissegundos" subtitle={`período: ${range}`}>
          {latency.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Sem dados no período.</p> : <TimeSeriesChart data={latency} title="Latência p95" height={220} series={[{ key: 'p95', label: 'p95' }]} formatValue={(v) => fmtMs(v)} formatAxis={(v) => `${v}`} {...common} />}
        </ChartCard>
        <ChartCard testId="company-chart-errors" title="Erros 5xx" unit="% das requisições" subtitle={`período: ${range}`}>
          {errors.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Sem dados no período.</p> : <TimeSeriesChart data={errors} title="Erros 5xx" height={220} series={[{ key: 'pct', label: 'Erros 5xx', color: CHART_DANGER }]} formatValue={(v) => `${v.toLocaleString('pt-BR')}%`} formatAxis={(v) => `${v}%`} {...common} />}
        </ChartCard>
      </section>

      <section aria-label="Alertas e incidentes" className="grid gap-4 lg:grid-cols-2">
        <Card data-testid="company-alerts">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Alertas recentes</CardTitle>
              <Link href={`/dashboard/observability/alertas?companyId=${id}`} className="text-xs underline">
                Abrir na central de alertas
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {data.alerts.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Nenhum alerta{severity ? ' com esta gravidade' : ''} para a empresa.</p>
            ) : (
              <ul className="divide-y">
                {data.alerts.map((a: any) => (
                  <li key={a.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/dashboard/observability/alertas?id=${a.id}`} className="font-medium underline">
                        {CATEGORY_LABEL[a.category] ?? a.category}
                      </Link>
                      <Pill className={ALERT_STATUS_STYLE[a.status]}>{ALERT_STATUS_LABEL[a.status] ?? a.status}</Pill>
                      <span className="text-xs text-muted-foreground">{SEVERITY_LABEL[a.severity] ?? a.severity} · {a.occurrences}x</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{a.detail ?? '—'} · desde {fmtDateTime(a.startedAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card data-testid="company-incidents">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Incidentes de saúde no período</CardTitle>
          </CardHeader>
          <CardContent>
            {data.incidents.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Nenhum incidente de saúde das filiais no período.</p>
            ) : (
              <ul className="divide-y">
                {data.incidents.map((i: any) => (
                  <li key={i.id} className="py-2 text-sm">
                    {i.component} · {i.status} <span className="text-xs text-muted-foreground">desde {fmtDateTime(i.startedAt)}{i.endedAt ? ` até ${fmtDateTime(i.endedAt)}` : ' (em aberto)'}</span>
                    {i.detail && <p className="text-xs text-muted-foreground">{i.detail}</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
