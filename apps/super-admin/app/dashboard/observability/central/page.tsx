'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TimeSeriesChart, type TimePoint } from '@/components/charts/TimeSeriesChart';
import { BarCompareChart, type BarRow } from '@/components/charts/BarCompareChart';
import { PercentGauge } from '@/components/charts/PercentGauge';
import { CHART_DANGER, CHART_SECONDARY, CHART_WARNING } from '@/lib/chart-theme';
import { centralApi, apiErrorMessage, type CentralRange } from '@/lib/api';
import { labelFormatter, tickFormatter } from '@/lib/chart-time';
import { LoadingState } from '../_components/states';
import {
  ALERT_STATUS_LABEL,
  ALERT_STATUS_STYLE,
  CATEGORY_LABEL,
  RANGE_STEP_MS,
  SEVERITY_LABEL,
  availabilityStatus,
  fmtAgo,
  fmtBytes,
  fmtDateTime,
  fmtInt,
  fmtMs,
  fmtPct,
  healthPctStatus,
  isLongRange,
} from '../_central/format';
import { ChartCard, Freshness, InlineError, Kpi, Notice, Pill, RangeSelector, StatusPill } from '../_central/ui';
import { mergeSeries } from '../_central/series';

const dash = '—';

export default function CentralPage() {
  const [range, setRange] = useState<CentralRange>('24h');
  const [overview, setOverview] = useState<any>(null);
  const [series, setSeries] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [o, s] = await Promise.all([centralApi.overview(range), centralApi.series(range)]);
      setOverview(o.data);
      setSeries(s.data);
      setError(null);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar a Central de Monitoramento.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const long = isLongRange(range);
  const stepMs = (series?.bucketSeconds ?? RANGE_STEP_MS[range] / 1000) * 1000;
  const common = { stepMs, formatTick: tickFormatter(long), formatLabel: labelFormatter, singlePointPadMs: stepMs };

  const availabilityData = useMemo(
    () =>
      series
        ? mergeSeries([
            { key: 'overall', rows: series.availability.overall, field: 'availabilityPct' },
            { key: 'database', rows: series.availability.perService.DATABASE, field: 'availabilityPct' },
            { key: 'redis', rows: series.availability.perService.REDIS, field: 'availabilityPct' },
            { key: 'queues', rows: series.availability.perService.QUEUES, field: 'availabilityPct' },
          ])
        : [],
    [series]
  );
  const latencyData = useMemo(() => (series ? series.api.map((p: any) => ({ t: p.t, p95: p.p95Ms })) : []), [series]);
  const errorData = useMemo(() => (series ? series.api.map((p: any) => ({ t: p.t, pct: p.errorPct })) : []), [series]);
  const volumeData = useMemo(() => (series ? series.api.map((p: any) => ({ t: p.t, requests: p.requests })) : []), [series]);
  const hostData = useMemo(
    () =>
      series
        ? mergeSeries([
            { key: 'cpu', rows: series.host.HOST_CPU, field: 'avg' },
            { key: 'mem', rows: series.host.HOST_MEMORY, field: 'avg' },
            { key: 'disk', rows: series.host.HOST_DISK, field: 'avg' },
          ])
        : [],
    [series]
  );
  const activeDaily = useMemo(() => (series ? series.companies.activeDaily.map((d: any) => ({ t: d.t, active: d.active, onboarding: d.onboarding })) : []), [series]);

  if (loading && !overview) return <LoadingState label="Carregando a Central de Monitoramento..." />;
  if (!overview) return <InlineError message={error ?? 'Sem dados.'} onRetry={load} />;

  const o = overview;
  const sev = o.alerts.bySeverity;
  const criticalCount = (sev.CRITICAL ?? 0) + (sev.OFFLINE ?? 0);
  const alertStatus = criticalCount > 0 ? 'CRITICAL' : sev.ATTENTION > 0 ? 'ATTENTION' : 'NORMAL';
  const errStatus = o.api.errorPct === null ? 'NO_DATA' : o.api.errorPct >= 5 ? 'CRITICAL' : o.api.errorPct >= 1 ? 'ATTENTION' : 'NORMAL';
  const latStatus = o.api.p95Ms === null ? 'NO_DATA' : o.api.p95Ms >= 2000 ? 'CRITICAL' : o.api.p95Ms >= 800 ? 'ATTENTION' : 'NORMAL';
  const severityRows: BarRow[] = [
    { id: 'OFFLINE', label: SEVERITY_LABEL.OFFLINE, value: sev.OFFLINE ?? 0, color: CHART_DANGER },
    { id: 'CRITICAL', label: SEVERITY_LABEL.CRITICAL, value: sev.CRITICAL ?? 0, color: CHART_DANGER },
    { id: 'ATTENTION', label: SEVERITY_LABEL.ATTENTION, value: sev.ATTENTION ?? 0, color: CHART_WARNING },
  ];
  const categoryRows: BarRow[] = Object.entries(o.alerts.byCategory as Record<string, number>).map(([k, v]) => ({ id: k, label: CATEGORY_LABEL[k] ?? k, value: v }));
  const monthRows: BarRow[] = series.companies.newPerMonth.map((m: any) => ({ id: m.month, label: m.month, value: m.count }));
  const b = o.backup;
  const infra = o.infra;
  const avail = o.availability;
  const coverage: number | null = avail.perService.DATABASE?.coveragePct ?? null;
  const lowCoverage = avail.overall.availabilityPct !== null && coverage !== null && coverage < 50;

  return (
    <div className="space-y-6" data-testid="central-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Central de Monitoramento</h2>
          <p className="text-sm text-muted-foreground">Visão executiva da plataforma: disponibilidade, desempenho, empresas, integrações, alertas e backups.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <RangeSelector value={range} onChange={setRange} />
          <Freshness generatedAt={o.generatedAt} stale={o.freshness.stale} staleNote={o.freshness.sampling ? 'Coleta de amostras atrasada ou sem dados recentes' : 'Coleta de amostras desligada'} onRefresh={load} refreshing={refreshing} />
        </div>
      </div>

      {error && <InlineError message={error} onRetry={load} />}
      {o.environment.local && <Notice testId="env-local">{o.environment.note}</Notice>}

      <section aria-label="Indicadores principais" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi
          testId="kpi-availability"
          title="Disponibilidade dos serviços"
          value={fmtPct(avail.overall.availabilityPct, 2)}
          status={lowCoverage ? 'ATTENTION' : availabilityStatus(avail.overall.availabilityPct)}
          statusLabel={lowCoverage ? 'Cobertura baixa' : undefined}
          hint={`${fmtInt(avail.overall.samples)} amostras · cobertura da coleta ${fmtPct(coverage)}${lowCoverage ? ' — poucas amostras no período: o percentual ainda não é representativo' : ''}`}
          definition={o.definitions.availability}
        />
        <Kpi testId="kpi-latency" title="Latência da API (p95)" value={fmtMs(o.api.p95Ms)} status={latStatus} hint={`${fmtInt(o.api.requests)} requisições no período`} definition={o.definitions.apiLatency} />
        <Kpi testId="kpi-errors" title="Taxa de erros (5xx)" value={fmtPct(o.api.errorPct)} status={errStatus} hint={`${fmtInt(o.api.errors)} erros em ${fmtInt(o.api.requests)} requisições`} definition={o.definitions.errorRate} />
        <Kpi
          testId="kpi-companies"
          title="Empresas cadastradas"
          value={fmtInt(o.companies.total)}
          hint={`${o.companies.active} ativas · ${o.companies.onboarding} em implantação · ${o.companies.suspended} suspensas`}
          definition={o.definitions.companies}
        >
          <Link href="/dashboard/observability/empresas" className="mt-2 inline-block text-xs underline">
            Comparar empresas
          </Link>
        </Kpi>
        <Kpi
          testId="kpi-integrations"
          title="Saúde das integrações"
          value={o.integrations.healthPct === null ? 'Sem dados' : fmtPct(o.integrations.healthPct)}
          status={healthPctStatus(o.integrations.healthPct)}
          hint={`${o.integrations.verified} verificadas · ${o.integrations.notConfigured} não configuradas · ${o.integrations.notVerified} não verificadas · ${o.integrations.error} com erro · ${o.integrations.disabled} desativadas`}
          definition={o.definitions.integrationHealth}
        >
          <div className="mt-2">
            <PercentGauge value={o.integrations.healthPct} label="Integrações verificadas saudáveis" tone={o.integrations.healthPct === null ? 'neutral' : o.integrations.healthPct >= 90 ? 'good' : o.integrations.healthPct >= 60 ? 'warn' : 'bad'} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{o.integrations.companiesWithoutVerified} de {o.integrations.companiesTotal} empresas ativas ainda sem integração verificada.</p>
        </Kpi>
        <Kpi
          testId="kpi-alerts"
          title="Alertas abertos"
          value={fmtInt(o.alerts.open)}
          status={alertStatus}
          hint={`${criticalCount} críticos · ${sev.ATTENTION ?? 0} em atenção · ${o.alerts.unhandled} ainda sem tratamento`}
        >
          <Link href="/dashboard/observability/alertas" className="mt-2 inline-block text-xs underline">
            Abrir a central de alertas
          </Link>
        </Kpi>
      </section>

      <section aria-label="Infraestrutura" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi testId="infra-database" title="Banco de dados (PostgreSQL)" value={infra.database ? <StatusPill status={infra.database.status} /> : 'Sem leitura'} hint={infra.database ? `latência ${fmtMs(infra.database.latencyMs)}` : 'a leitura ao vivo falhou'} />
        <Kpi testId="infra-redis" title="Cache e filas (Redis)" value={infra.redis ? <StatusPill status={infra.redis.status} /> : 'Sem leitura'} hint={infra.redis ? `latência ${fmtMs(infra.redis.latencyMs)} · memória ${infra.redis.memoryMb ?? dash} MB` : 'a leitura ao vivo falhou'} />
        <Kpi
          testId="infra-queues"
          title="Filas e tarefas"
          value={infra.queues ? <StatusPill status={infra.queues.status} /> : 'Sem leitura'}
          hint={infra.queues ? `${infra.queues.waiting} aguardando · ${infra.queues.failedLastHour} falhas na última hora · ${infra.queues.overdue} atrasadas · ${infra.queues.workersDown} worker(s) parado(s)` : 'a leitura ao vivo falhou'}
        >
          <Link href="/dashboard/observability/jobs" className="mt-2 inline-block text-xs underline">
            Ver filas
          </Link>
        </Kpi>
        <Card data-testid="infra-host">
          <CardContent className="space-y-2 p-4">
            <p className="text-sm text-muted-foreground">Servidor da API</p>
            <PercentGauge value={infra.host.cpuPct} label="CPU" tone={infra.host.cpuPct !== null && infra.host.cpuPct >= 95 ? 'bad' : infra.host.cpuPct !== null && infra.host.cpuPct >= 80 ? 'warn' : 'neutral'} />
            <PercentGauge value={infra.host.memPct} label="Memória" tone={infra.host.memPct !== null && infra.host.memPct >= 95 ? 'bad' : infra.host.memPct !== null && infra.host.memPct >= 85 ? 'warn' : 'neutral'} />
            <PercentGauge value={infra.host.diskPct} label="Disco" tone={infra.host.diskPct !== null && infra.host.diskPct >= 95 ? 'bad' : infra.host.diskPct !== null && infra.host.diskPct >= 85 ? 'warn' : 'neutral'} />
            <p className="text-xs text-muted-foreground">{infra.host.note}</p>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Evolução" className="grid gap-4 lg:grid-cols-2">
        <ChartCard testId="chart-availability" title="Disponibilidade ao longo do tempo" unit="% de amostras sem estado Fora do ar" subtitle={`período: ${range}`} definition={o.definitions.availability}>
          {availabilityData.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Ainda sem amostras neste período: o coletor grava uma amostra a cada {o.freshness.sampleIntervalMinutes} min. Lacunas são mostradas como lacunas, não como 100%.</p>
          ) : (
            <TimeSeriesChart
              data={availabilityData}
              title="Disponibilidade"
              height={260}
              series={[
                { key: 'overall', label: 'Geral' },
                { key: 'database', label: 'Banco', color: CHART_SECONDARY, dashed: true },
                { key: 'redis', label: 'Redis', color: CHART_WARNING, dashed: true },
                { key: 'queues', label: 'Filas', color: CHART_DANGER, dashed: true },
              ]}
              formatValue={(v) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`}
              formatAxis={(v) => `${v}%`}
              {...common}
            />
          )}
        </ChartCard>
        <ChartCard testId="chart-latency" title="Latência da API (p95)" unit="milissegundos" subtitle={`período: ${range}`} definition={o.definitions.apiLatency}>
          {latencyData.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma requisição registrada no período.</p>
          ) : (
            <TimeSeriesChart data={latencyData} title="Latência p95" height={260} series={[{ key: 'p95', label: 'p95' }]} formatValue={(v) => fmtMs(v)} formatAxis={(v) => `${v}`} {...common} />
          )}
        </ChartCard>
        <ChartCard testId="chart-errors" title="Taxa de erros 5xx" unit="% das requisições" subtitle={`período: ${range}`} definition={o.definitions.errorRate}>
          {errorData.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma requisição registrada no período.</p>
          ) : (
            <TimeSeriesChart data={errorData} title="Taxa de erros" height={260} series={[{ key: 'pct', label: 'Erros 5xx', color: CHART_DANGER }]} formatValue={(v) => `${v.toLocaleString('pt-BR')}%`} formatAxis={(v) => `${v}%`} {...common} />
          )}
        </ChartCard>
        <ChartCard testId="chart-volume" title="Volume de requisições" unit="requisições por intervalo" subtitle={`período: ${range}`}>
          {volumeData.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma requisição registrada no período.</p>
          ) : (
            <TimeSeriesChart data={volumeData} title="Volume de requisições" height={260} series={[{ key: 'requests', label: 'Requisições' }]} formatValue={(v) => v.toLocaleString('pt-BR')} formatAxis={(v) => v.toLocaleString('pt-BR')} {...common} />
          )}
        </ChartCard>
        <ChartCard testId="chart-host" title="Uso do servidor da API" unit="% (média por intervalo)" subtitle={`período: ${range}`}>
          {hostData.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Ainda sem amostras do servidor neste período.</p>
          ) : (
            <TimeSeriesChart
              data={hostData}
              title="Uso do servidor"
              height={260}
              series={[
                { key: 'cpu', label: 'CPU' },
                { key: 'mem', label: 'Memória', color: CHART_SECONDARY },
                { key: 'disk', label: 'Disco', color: CHART_WARNING, dashed: true },
              ]}
              formatValue={(v) => `${v.toLocaleString('pt-BR')}%`}
              formatAxis={(v) => `${v}%`}
              {...common}
            />
          )}
        </ChartCard>
        <ChartCard testId="chart-companies-active" title="Empresas ativas por dia" unit="empresas" subtitle="medido a partir do início da coleta diária" definition={o.definitions.companies}>
          {activeDaily.length < 2 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{series.companies.coverage.note} Hoje há {activeDaily.length} ponto(s) coletado(s): a evolução precisa de pelo menos dois dias.</p>
          ) : (
            <TimeSeriesChart
              data={activeDaily}
              title="Empresas ativas"
              height={260}
              series={[
                { key: 'active', label: 'Ativas' },
                { key: 'onboarding', label: 'Em implantação', color: CHART_SECONDARY, dashed: true },
              ]}
              stepMs={86_400_000}
              singlePointPadMs={86_400_000}
              formatTick={tickFormatter(true)}
              formatLabel={labelFormatter}
              formatValue={(v) => v.toLocaleString('pt-BR')}
              formatAxis={(v) => `${v}`}
            />
          )}
        </ChartCard>
        <ChartCard testId="chart-companies-new" title="Novas empresas por mês" unit="empresas criadas" subtitle="medido: data de criação do cadastro">
          <BarCompareChart rows={monthRows} title="Novas empresas por mês" unit="empresas" formatValue={(v) => `${v}`} layout="vertical" height={240} />
        </ChartCard>
        <ChartCard testId="chart-alerts" title="Alertas abertos por gravidade e categoria" unit="alertas abertos">
          <BarCompareChart rows={severityRows} title="Alertas por gravidade" unit="alertas" formatValue={(v) => `${v}`} height={130} />
          <div className="mt-3 border-t pt-3">
            <BarCompareChart rows={categoryRows} title="Alertas por categoria" unit="alertas" formatValue={(v) => `${v}`} />
          </div>
        </ChartCard>
      </section>

      <section aria-label="Backups" data-testid="backup-panel">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Backups e verificações</CardTitle>
              <StatusPill status={b.status} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground" data-testid="backup-reason">
              {b.reason}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3" data-testid="backup-created">
                <p className="text-xs text-muted-foreground">1. Backup criado</p>
                <p className="mt-1 text-sm font-medium">{b.lastCreatedAt ? `${fmtDateTime(b.lastCreatedAt)} (${fmtAgo(b.lastCreatedAt)})` : 'nenhum registrado'}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  tamanho {fmtBytes(b.sizeBytes)} · cifrado {b.encrypted === null ? dash : b.encrypted ? 'sim' : 'não'} · cópia externa {b.offsite === null ? dash : b.offsite ? 'sim' : 'não'}
                </p>
              </div>
              <div className="rounded-md border p-3" data-testid="backup-verified">
                <p className="text-xs text-muted-foreground">2. Backup verificado</p>
                <p className="mt-1 text-sm font-medium">{b.level === 'VERIFIED' ? 'Verificado' : b.lastVerify.state === 'falha' ? 'Verificação FALHOU' : 'Não verificado'}</p>
                <p className="mt-1 text-xs text-muted-foreground">{b.lastVerify.at ? `última verificação ${fmtDateTime(b.lastVerify.at)}${b.lastVerify.detail ? ` — ${b.lastVerify.detail}` : ''}` : 'nenhuma verificação registrada'}</p>
              </div>
              <div className="rounded-md border p-3" data-testid="backup-restore">
                <p className="text-xs text-muted-foreground">3. Restauração testada</p>
                <p className="mt-1 text-sm font-medium">Sem registro</p>
                <p className="mt-1 text-xs text-muted-foreground">{b.restoreTested.note}</p>
              </div>
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Como é calculado</summary>
              <p className="mt-1">{o.definitions.backup}</p>
            </details>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Histórico de incidentes" data-testid="incident-history">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Histórico de incidentes no período</CardTitle>
          </CardHeader>
          <CardContent>
            {o.incidents.alerts.length === 0 && o.incidents.health.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Nenhum alerta ou incidente de saúde no período.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Início</th>
                      <th className="py-2 pr-3 font-medium">Origem</th>
                      <th className="py-2 pr-3 font-medium">Alvo</th>
                      <th className="py-2 pr-3 font-medium">Gravidade</th>
                      <th className="py-2 pr-3 font-medium">Situação</th>
                      <th className="py-2 font-medium">Detalhe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.incidents.alerts.map((a: any) => (
                      <tr key={a.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(a.startedAt)}</td>
                        <td className="py-2 pr-3">
                          <Link href={`/dashboard/observability/alertas?id=${a.id}`} className="underline">
                            {CATEGORY_LABEL[a.category] ?? a.category}
                          </Link>
                        </td>
                        <td className="py-2 pr-3">{a.companyName ?? 'Infraestrutura central'}</td>
                        <td className="py-2 pr-3">{SEVERITY_LABEL[a.severity] ?? a.severity}</td>
                        <td className="py-2 pr-3">
                          <Pill className={ALERT_STATUS_STYLE[a.status]}>{ALERT_STATUS_LABEL[a.status] ?? a.status}</Pill>
                        </td>
                        <td className="py-2 text-muted-foreground">{a.detail ?? dash}</td>
                      </tr>
                    ))}
                    {o.incidents.health.map((i: any) => (
                      <tr key={i.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(i.startedAt)}</td>
                        <td className="py-2 pr-3">Saúde de filial · {i.component}</td>
                        <td className="py-2 pr-3">{i.companyName ?? dash}</td>
                        <td className="py-2 pr-3">{i.status}</td>
                        <td className="py-2 pr-3">
                          <Pill className={i.endedAt ? ALERT_STATUS_STYLE.RESOLVED : ALERT_STATUS_STYLE.OPEN}>{i.endedAt ? 'Encerrado' : 'Em aberto'}</Pill>
                        </td>
                        <td className="py-2 text-muted-foreground">{i.detail ?? dash}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
