'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { TimeSeriesChart, type TimeSeries } from '@/components/charts/TimeSeriesChart';
import { BarCompareChart, type BarRow } from '@/components/charts/BarCompareChart';
import { CHART_DANGER, CHART_PRIMARY, CHART_SECONDARY, CHART_WARNING } from '@/lib/chart-theme';
import { centralApi, apiErrorMessage, type CentralRange } from '@/lib/api';
import { labelFormatter, tickFormatter } from '@/lib/chart-time';
import { LoadingState } from '../observability/_components/states';
import {
  ALERT_STATUS_LABEL,
  ALERT_STATUS_STYLE,
  CATEGORY_LABEL,
  RANGE_STEP_MS,
  SEVERITY_LABEL,
  fmtAgo,
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtInt,
  fmtMs,
  fmtPct,
  isLongRange,
} from '../observability/_central/format';
import { mergeSeries } from '../observability/_central/series';
import { ChartCard, Freshness, InlineError, Kpi, Notice, Pill, RangeSelector, StatusPill } from '../observability/_central/ui';

// INFRAESTRUTURA (Super Admin). Reaproveita a Central de Monitoramento: os mesmos gráficos (Linha por padrão, Colunas como alternativa), a mesma central de alertas, as mesmas cores
// do tema (verde/amarelo/vermelho só como estado). Mostra só o que é realmente monitorado; ausência de dado aparece como "sem dados", nunca como 100%.
const RANGES: Array<{ key: CentralRange; label: string }> = [
  { key: '1h', label: '1 hora' },
  { key: '24h', label: '24 horas' },
  { key: '7d', label: '7 dias' },
  { key: '30d', label: '30 dias' },
];
const EXTERNAL_MONITOR_LABEL: Record<string, string> = { ACTIVE: 'Relatando', STALE: 'Parou de relatar', NEVER_REPORTED: 'Nunca relatou', DISABLED: 'Desligado' };
const CHANNEL_LABEL: Record<string, string> = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp', sentry: 'Sentry (erros)' };
const CHANNEL_STATE_LABEL: Record<string, string> = { ACTIVE: 'Configurado e ligado', DISABLED: 'Desligado', PENDING_CONFIGURATION: 'Pendente de configuração', INVALID: 'Configuração inválida', UNKNOWN: 'Sem leitura' };
const CHANNEL_STATE_STATUS: Record<string, string> = { ACTIVE: 'NORMAL', DISABLED: 'NO_DATA', PENDING_CONFIGURATION: 'ATTENTION', INVALID: 'CRITICAL', UNKNOWN: 'NO_DATA' };
const SERIES_STYLES: Array<Pick<TimeSeries, 'color' | 'dashed'>> = [{ color: CHART_PRIMARY }, { color: CHART_SECONDARY }, { color: CHART_SECONDARY, dashed: true }, { color: CHART_PRIMARY, dashed: true }];
const MAX_LINES = 4;

interface Filters {
  service: string;
  severity: string;
  state: string;
  scope: string;
}
const NO_FILTERS: Filters = { service: '', severity: '', state: '', scope: '' };

export default function InfraestruturaPage() {
  const [range, setRange] = useState<CentralRange>('24h');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [data, setData] = useState<any>(null);
  const [serviceOptions, setServiceOptions] = useState<Array<{ key: string; label: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await centralApi.infrastructure({ range, ...filters });
      setData(res.data);
      // a lista do filtro vem da leitura SEM filtro de serviço (com ele, só voltaria o próprio serviço)
      if (!filters.service) setServiceOptions((res.data.services as any[]).map((s) => ({ key: s.key, label: s.label })));
      setError(null);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar a Infraestrutura.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range, filters]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const long = isLongRange(range);
  const stepMs = (data?.bucketSeconds ?? RANGE_STEP_MS[range] / 1000) * 1000;
  const common = { stepMs, formatTick: tickFormatter(long), formatLabel: labelFormatter, singlePointPadMs: stepMs };

  const labelOf = useCallback((key: string) => (data?.services as any[] | undefined)?.find((s) => s.key === key)?.label ?? key, [data]);

  const lines = useCallback(
    (bucket: Record<string, any[]> | undefined, field: string) => {
      const keys = Object.keys(bucket ?? {});
      const shown = keys.slice(0, MAX_LINES);
      const chartSeries: TimeSeries[] = shown.map((k, i) => ({ key: k, label: labelOf(k), ...SERIES_STYLES[i] }));
      const rows = mergeSeries(shown.map((k) => ({ key: k, rows: (bucket as Record<string, any[]>)[k], field })));
      return { chartSeries, rows, hidden: keys.length - shown.length };
    },
    [labelOf]
  );

  const latency = useMemo(() => lines(data?.series?.latency, 'avgMs'), [data, lines]);
  const availability = useMemo(() => lines(data?.series?.availability, 'availabilityPct'), [data, lines]);
  const capacity = useMemo(() => {
    const cap = data?.series?.capacity ?? {};
    const chartSeries: TimeSeries[] = Object.keys(cap).map((k, i) => ({ key: k, label: labelOf(k), ...SERIES_STYLES[i % SERIES_STYLES.length] }));
    return { chartSeries, rows: mergeSeries(Object.keys(cap).map((k) => ({ key: k, rows: cap[k], field: 'pct' }))) };
  }, [data, labelOf]);
  const volume = useMemo(() => (data ? data.series.api.map((p: any) => ({ t: p.t, requests: p.requests })) : []), [data]);
  const errorRate = useMemo(() => (data ? data.series.api.map((p: any) => ({ t: p.t, pct: p.errorPct })) : []), [data]);
  const apiLatency = useMemo(() => (data ? data.series.api.map((p: any) => ({ t: p.t, avg: p.avgMs, p95: p.p95Ms })) : []), [data]);

  if (loading && !data) return <LoadingState label="Carregando a Infraestrutura..." />;
  if (!data) return <InlineError message={error ?? 'Sem dados.'} onRetry={load} />;

  const services: any[] = data.services;
  const withData = services.filter((s) => s.availabilityPct !== null);
  const worst = withData.length ? withData.reduce((a, b) => (a.availabilityPct <= b.availabilityPct ? a : b)) : null;
  const failingNow = services.filter((s) => s.state === 'CRITICAL' || s.state === 'OFFLINE').length;
  const api = data.api;
  const errStatus = api.errorPct === null ? 'NO_DATA' : api.errorPct >= 5 ? 'CRITICAL' : api.errorPct >= 1 ? 'ATTENTION' : 'NORMAL';
  const latStatus = api.p95Ms === null ? 'NO_DATA' : api.p95Ms >= 2000 ? 'CRITICAL' : api.p95Ms >= 800 ? 'ATTENTION' : 'NORMAL';
  const tech = data.alerts.technical;
  const oper = data.alerts.operational;
  const ext = data.externalMonitor;
  const classes = data.http.classes as Record<string, number>;
  const classRows: BarRow[] = [
    { id: '2xx', label: '2xx sucesso', value: classes['2xx'] },
    { id: '3xx', label: '3xx redirecionamento', value: classes['3xx'] },
    { id: '4xx', label: '4xx erro do cliente', value: classes['4xx'], color: CHART_WARNING },
    { id: '5xx', label: '5xx erro do servidor', value: classes['5xx'], color: CHART_DANGER },
  ];
  const filtered = Object.values(filters).some(Boolean);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const ch = data.dependencies.channels as Record<string, any> | null;
  const backup = data.dependencies.backup;

  return (
    <div className="space-y-6" data-testid="infra-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Infraestrutura</h1>
          <p className="text-muted-foreground">Serviços, dependências, requisições da API e incidentes — o que está realmente sendo monitorado, medido por dentro e (quando implantado) por fora.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <RangeSelector value={range} onChange={setRange} options={RANGES} />
          <Freshness generatedAt={data.generatedAt} stale={data.collection.stale} staleNote={data.collection.sampling ? 'Coleta de amostras atrasada ou sem dados recentes' : 'Coleta de amostras desligada'} onRefresh={load} refreshing={refreshing} />
        </div>
      </div>

      {error && <InlineError message={error} onRetry={load} />}

      <section aria-label="Estado da coleta" className="grid gap-3 lg:grid-cols-2">
        <Notice tone={data.collection.stale ? 'warn' : 'info'} testId="infra-collection">
          <strong>Coleta interna:</strong>{' '}
          {data.collection.lastSampleAt ? `última amostra ${fmtAgo(data.collection.lastSampleAt)} (${fmtDateTime(data.collection.lastSampleAt)}), a cada ${data.collection.sampleIntervalMinutes} min.` : 'nenhuma amostra gravada ainda neste período — sem dados, não "tudo certo".'}
        </Notice>
        <Notice tone={ext.state === 'ACTIVE' ? 'info' : 'warn'} testId="infra-external">
          <strong>Monitor externo: {EXTERNAL_MONITOR_LABEL[ext.state] ?? ext.state}.</strong> {ext.note}
          {ext.lastReportAt ? ` Último relato ${fmtAgo(ext.lastReportAt)}.` : ''}
        </Notice>
      </section>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5" data-testid="infra-filters">
          <label className="text-xs text-muted-foreground">
            Serviço
            <Select value={filters.service} onChange={(e) => set({ service: e.target.value })} data-testid="filter-service" className="mt-1">
              <option value="">Todos</option>
              {serviceOptions.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
              {filters.service && !serviceOptions.some((s) => s.key === filters.service) && <option value={filters.service}>{filters.service}</option>}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Gravidade
            <Select value={filters.severity} onChange={(e) => set({ severity: e.target.value })} data-testid="filter-severity" className="mt-1">
              <option value="">Todas</option>
              {Object.entries(SEVERITY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Estado do incidente
            <Select value={filters.state} onChange={(e) => set({ state: e.target.value })} data-testid="filter-state" className="mt-1">
              <option value="">Todos</option>
              <option value="OPEN">Abertos</option>
              <option value="RESOLVED">Encerrados</option>
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Tipo
            <Select value={filters.scope} onChange={(e) => set({ scope: e.target.value })} data-testid="filter-scope" className="mt-1">
              <option value="">Técnicos e operacionais</option>
              <option value="technical">Técnicos (plataforma)</option>
              <option value="operational">Operacionais (empresas e filiais)</option>
            </Select>
          </label>
          <div className="flex items-end">
            <Button type="button" variant="outline" size="sm" disabled={!filtered} onClick={() => setFilters(NO_FILTERS)} data-testid="filter-clear">
              Limpar filtros
            </Button>
          </div>
        </CardContent>
      </Card>

      <section aria-label="Indicadores principais" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi
          testId="infra-kpi-services"
          title="Serviços monitorados"
          value={fmtInt(services.length)}
          status={services.length === 0 ? 'NO_DATA' : failingNow > 0 ? 'CRITICAL' : 'NORMAL'}
          statusLabel={services.length === 0 ? 'Sem dados' : failingNow > 0 ? `${failingNow} com falha` : 'Sem falha agora'}
          hint={services.length === 0 ? 'nenhuma amostra no período' : `${services.filter((s) => s.external).length} medidos de fora · ${services.filter((s) => !s.external).length} internos`}
        />
        <Kpi
          testId="infra-kpi-availability"
          title="Pior disponibilidade"
          value={worst ? fmtPct(worst.availabilityPct, 2) : '—'}
          hint={worst ? `${worst.label} (${fmtInt(worst.failures)} falha(s) em ${fmtInt(worst.samples)} amostras)` : 'sem amostras no período'}
          status={!worst ? 'NO_DATA' : worst.availabilityPct >= 99 ? 'NORMAL' : worst.availabilityPct >= 95 ? 'ATTENTION' : 'CRITICAL'}
        />
        <Kpi testId="infra-kpi-requests" title="Requisições da API" value={fmtInt(api.requests)} hint={`média ${fmtMs(api.avgMs)} · p95 ${fmtMs(api.p95Ms)}`} status={latStatus} definition={api.definition} />
        <Kpi testId="infra-kpi-errors" title="Taxa de erros (5xx)" value={fmtPct(api.errorPct)} status={errStatus} hint={`${fmtInt(api.errors)} erro(s) em ${fmtInt(api.requests)} requisições`} />
        <Kpi
          testId="infra-kpi-technical"
          title="Alertas técnicos abertos"
          value={fmtInt(tech.open)}
          status={tech.bySeverity.CRITICAL + tech.bySeverity.OFFLINE > 0 ? 'CRITICAL' : tech.bySeverity.ATTENTION > 0 ? 'ATTENTION' : 'NORMAL'}
          hint={`${tech.bySeverity.CRITICAL + tech.bySeverity.OFFLINE} críticos · ${tech.bySeverity.ATTENTION} em atenção`}
        />
        <Kpi
          testId="infra-kpi-operational"
          title="Alertas operacionais abertos"
          value={fmtInt(oper.open)}
          status={oper.bySeverity.CRITICAL + oper.bySeverity.OFFLINE > 0 ? 'CRITICAL' : oper.bySeverity.ATTENTION > 0 ? 'ATTENTION' : 'NORMAL'}
          hint={`empresas, filiais e equipamentos · ${oper.healthIncidentsOpen} incidente(s) de saúde por filial abertos`}
        >
          <Link href="/dashboard/observability/alertas" className="mt-2 inline-block text-xs underline">
            Abrir a central de alertas
          </Link>
        </Kpi>
      </section>

      <section aria-label="Serviços" className="space-y-3">
        <h2 className="text-lg font-semibold">Serviços e dependências</h2>
        {services.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground" data-testid="infra-services-empty">
              {filtered ? 'Nenhum serviço corresponde aos filtros neste período.' : 'Nenhum serviço com amostras neste período. A coleta ainda não gravou dados — veja o estado da coleta acima.'}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="infra-services">
            {services.map((s) => (
              <Card key={s.key} data-testid={`service-${s.key}`}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-medium">{s.label}</p>
                    <StatusPill status={s.state} />
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {s.external && <Pill className="bg-muted text-foreground border-border">Medido de fora</Pill>}
                    <span>Última verificação {fmtAgo(s.lastCheckAt)}</span>
                  </div>
                  {s.kind === 'capacity' ? (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Uso agora</dt>
                      <dd className="text-right tabular-nums">{fmtPct(s.lastValuePct)}</dd>
                      <dt className="text-muted-foreground">Uso médio</dt>
                      <dd className="text-right tabular-nums">{fmtPct(s.avgPct)}</dd>
                    </dl>
                  ) : (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Latência agora</dt>
                      <dd className="text-right tabular-nums">{fmtMs(s.lastLatencyMs)}</dd>
                      <dt className="text-muted-foreground">Média · p95</dt>
                      <dd className="text-right tabular-nums">{fmtMs(s.avgMs)} · {fmtMs(s.p95Ms)}</dd>
                      <dt className="text-muted-foreground">Disponibilidade</dt>
                      <dd className="text-right tabular-nums">{fmtPct(s.availabilityPct, 2)}</dd>
                      <dt className="text-muted-foreground">Falhas / amostras</dt>
                      <dd className="text-right tabular-nums">{fmtInt(s.failures)} / {fmtInt(s.samples)}</dd>
                    </dl>
                  )}
                  {s.detail && <p className="break-words text-xs text-muted-foreground">{s.detail}</p>}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Evolução no tempo" className="grid gap-4 xl:grid-cols-2">
        <ChartCard testId="chart-latency" title="Latência dos serviços" unit="ms" subtitle="média por intervalo" definition="Tempo de resposta medido em cada verificação (banco, Redis e alvos medidos de fora). A linha se interrompe onde não houve verificação.">
          {latency.rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Sem medições de latência neste período.</p>
          ) : (
            <TimeSeriesChart title="Latência dos serviços" data={latency.rows} series={latency.chartSeries} {...common} formatValue={(v) => fmtMs(v)} formatAxis={(v) => fmtMs(v)} footnote={latency.hidden > 0 ? <p className="mt-2 text-xs text-muted-foreground">Mostrando {MAX_LINES} de {MAX_LINES + latency.hidden} serviços; use o filtro de serviço para ver os demais.</p> : undefined} />
          )}
        </ChartCard>
        <ChartCard testId="chart-availability" title="Disponibilidade dos serviços" unit="%" subtitle="por intervalo" definition="Amostras sem falha ÷ amostras coletadas no intervalo. Para alvos medidos de fora, qualquer resposta fora do esperado conta como falha.">
          {availability.rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Sem amostras de disponibilidade neste período.</p>
          ) : (
            <TimeSeriesChart title="Disponibilidade dos serviços" data={availability.rows} series={availability.chartSeries} {...common} formatValue={(v) => fmtPct(v, 2)} formatAxis={(v) => `${v}%`} footnote={availability.hidden > 0 ? <p className="mt-2 text-xs text-muted-foreground">Mostrando {MAX_LINES} de {MAX_LINES + availability.hidden} serviços; use o filtro de serviço para ver os demais.</p> : undefined} />
          )}
        </ChartCard>
        <ChartCard testId="chart-volume" title="Volume de requisições da API" unit="requisições" subtitle="por intervalo" definition={api.definition}>
          {volume.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma requisição registrada neste período.</p>
          ) : (
            <TimeSeriesChart title="Volume de requisições" data={volume} series={[{ key: 'requests', label: 'Requisições' }]} {...common} formatValue={(v) => fmtInt(v)} formatAxis={(v) => fmtInt(v)} />
          )}
        </ChartCard>
        <ChartCard testId="chart-errors" title="Taxa de erros (5xx)" unit="%" subtitle="por intervalo" definition="Requisições com status 5xx ÷ requisições do intervalo.">
          {errorRate.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma requisição registrada neste período.</p>
          ) : (
            <TimeSeriesChart title="Taxa de erros 5xx" data={errorRate} series={[{ key: 'pct', label: 'Erros 5xx', color: CHART_DANGER }]} {...common} formatValue={(v) => fmtPct(v)} formatAxis={(v) => `${v}%`} />
          )}
        </ChartCard>
        <ChartCard testId="chart-api-latency" title="Latência da API" unit="ms" subtitle="média e p95 por intervalo">
          {apiLatency.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma requisição registrada neste período.</p>
          ) : (
            <TimeSeriesChart title="Latência da API" data={apiLatency} series={[{ key: 'avg', label: 'Média' }, { key: 'p95', label: 'p95', color: CHART_SECONDARY }]} {...common} formatValue={(v) => fmtMs(v)} formatAxis={(v) => fmtMs(v)} />
          )}
        </ChartCard>
        {capacity.rows.length > 0 && (
          <ChartCard testId="chart-capacity" title="Servidor: CPU, memória e disco" unit="%" subtitle="uso médio por intervalo" definition="Servidor onde a API roda. Em ambiente local é a máquina de desenvolvimento.">
            <TimeSeriesChart title="Uso do servidor" data={capacity.rows} series={capacity.chartSeries} {...common} formatValue={(v) => fmtPct(v)} formatAxis={(v) => `${v}%`} />
          </ChartCard>
        )}
      </section>

      <section aria-label="Códigos HTTP" className="grid gap-4 lg:grid-cols-2">
        <ChartCard testId="chart-http" title="Requisições por classe de status HTTP" unit="requisições" subtitle="no período">
          {data.http.total === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma requisição registrada neste período.</p>
          ) : (
            <BarCompareChart rows={classRows} title="Requisições por classe HTTP" unit="requisições" formatValue={(v) => fmtInt(v)} testId="http-classes" />
          )}
        </ChartCard>
        <Card data-testid="http-codes">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Códigos mais frequentes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {data.http.top.length === 0 ? (
              <p className="text-muted-foreground">Sem requisições no período.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                {data.http.top.map((c: any) => (
                  <li key={c.code} className="flex justify-between gap-2">
                    <span className="font-medium tabular-nums">{c.code}</span>
                    <span className="tabular-nums text-muted-foreground">{fmtInt(c.count)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Erros do servidor (5xx)</p>
              {data.http.serverErrors.length === 0 ? (
                <p className="text-muted-foreground">Nenhum 5xx no período.</p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {data.http.serverErrors.map((c: any) => (
                    <li key={c.code}>
                      <Pill className="bg-danger-soft text-danger border-danger/40">{c.code} · {fmtInt(c.count)}</Pill>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Dependências e canais de aviso" className="grid gap-4 lg:grid-cols-2">
        <Card data-testid="infra-backup">
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
              Backup
              <StatusPill status={backup.status} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {backup.configured ? (
              <>
                <p>Último backup {fmtAgo(backup.lastCreatedAt)} · {fmtBytes(backup.sizeBytes)}{backup.encrypted === null ? '' : backup.encrypted ? ' · cifrado' : ' · SEM cifra'}</p>
                <p className="text-muted-foreground">Verificação: {backup.lastVerify?.state ?? 'sem registro'}</p>
              </>
            ) : (
              <p className="text-muted-foreground">{backup.reason}</p>
            )}
            <p className="text-xs text-muted-foreground">{backup.restoreTested?.note}</p>
          </CardContent>
        </Card>
        <Card data-testid="infra-channels">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Canais de aviso de incidentes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!ch ? (
              <p className="text-muted-foreground">Sem leitura do estado dos canais.</p>
            ) : (
              Object.entries(ch).map(([k, c]: [string, any]) => (
                <div key={k} className="space-y-1" data-testid={`channel-${k}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{CHANNEL_LABEL[k] ?? k}</span>
                    <StatusPill status={CHANNEL_STATE_STATUS[c.state] ?? 'NO_DATA'} label={CHANNEL_STATE_LABEL[c.state] ?? c.state} />
                  </div>
                  {c.missing?.length > 0 && <p className="break-words text-xs text-muted-foreground">Falta: {c.missing.join(' · ')}</p>}
                  {c.consumption && <p className="text-xs text-muted-foreground">Aceitos pelo provedor: {c.consumption.sent.hour}/h · {c.consumption.sent.day}/dia · falhas 24 h: {c.consumption.failed24h}</p>}
                </div>
              ))
            )}
            <p className="text-xs text-muted-foreground">&ldquo;Aceito pelo provedor&rdquo; não é &ldquo;entregue no aparelho&rdquo;: a confirmação de entrega depende do provedor.</p>
            <Link href="/dashboard/observability/externos" className="inline-block text-xs underline">Detalhes e limites dos serviços externos</Link>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Incidentes" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-lg font-semibold">Incidentes</h2>
          <p className="text-xs text-muted-foreground">Mesmos registros da central de alertas — sem duplicar. Duração e recuperação vêm do próprio registro.</p>
        </div>
        {data.incidents.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground" data-testid="infra-incidents-empty">
              {filtered ? 'Nenhum incidente corresponde aos filtros neste período.' : 'Nenhum incidente neste período.'}
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-3" data-testid="infra-incidents">
            {data.incidents.map((i: any) => (
              <li key={i.id}>
                <Card data-testid={`incident-${i.type}`}>
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill className="bg-muted text-foreground border-border">{i.scope === 'technical' ? 'Técnico' : 'Operacional'}</Pill>
                      <Pill className="bg-muted text-muted-foreground border-border">{CATEGORY_LABEL[i.category] ?? i.category}</Pill>
                      <StatusPill status={i.severity} label={SEVERITY_LABEL[i.severity] ?? i.severity} />
                      <Pill className={ALERT_STATUS_STYLE[i.status]}>{ALERT_STATUS_LABEL[i.status] ?? i.status}</Pill>
                      {i.companyName && <span className="text-xs text-muted-foreground">{i.companyName}</span>}
                    </div>
                    <p className="break-words text-sm font-medium">{i.type}</p>
                    {i.detail && <p className="break-words text-sm text-muted-foreground">{i.detail}</p>}
                    <dl className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                      <div>
                        <dt>Início</dt>
                        <dd className="text-foreground">{fmtDateTime(i.startedAt)}</dd>
                      </div>
                      <div>
                        <dt>{i.endedAt ? 'Duração' : 'Aberto há'}</dt>
                        <dd className="text-foreground">{fmtDuration(i.durationMs)}</dd>
                      </div>
                      <div>
                        <dt>Recuperação</dt>
                        <dd className="text-foreground">{i.recovery === 'AUTOMATIC' ? 'Automática' : i.recovery === 'MANUAL' ? 'Manual' : 'Ainda aberto'}</dd>
                      </div>
                      <div>
                        <dt>Ocorrências</dt>
                        <dd className="text-foreground">{fmtInt(i.occurrences)}</dd>
                      </div>
                    </dl>
                    {i.guidance && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">Causa provável e orientação</summary>
                        <p className="mt-1 leading-relaxed">{i.guidance}</p>
                      </details>
                    )}
                    <Link href={`/dashboard/observability/alertas?id=${i.id}`} className="inline-block text-xs underline">
                      Abrir na central de alertas
                    </Link>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {data.incidentsTruncated && <p className="text-xs text-muted-foreground">Mostrando os 100 mais recentes; refine pelos filtros.</p>}
      </section>
    </div>
  );
}
