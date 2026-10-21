'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { BarCompareChart, type BarRow } from '@/components/charts/BarCompareChart';
import { centralApi, apiErrorMessage, type CentralRange } from '@/lib/api';
import { LoadingState } from '../_components/states';
import { LIFECYCLE_LABEL, fmtAgo, fmtInt, fmtMs, fmtPct } from '../_central/format';
import { ChartCard, Freshness, InlineError, Pill, RangeSelector, StatusPill } from '../_central/ui';

// Comparação entre empresas: tabela com filtro, ordenação e paginação + gráfico de barras do indicador escolhido. Os números vêm do banco (request_logs, integrações, alertas);
// o que não tem dado fica "—" e fora do gráfico. Só o Super Admin chega aqui (o backend recusa qualquer outro papel).
const METRICS = [
  { key: 'requests', label: 'Requisições', unit: 'requisições', fmt: (v: number) => fmtInt(v) },
  { key: 'errorPct', label: 'Taxa de erros 5xx', unit: '% das requisições', fmt: (v: number) => fmtPct(v) },
  { key: 'p95Ms', label: 'Latência p95', unit: 'milissegundos', fmt: (v: number) => fmtMs(v) },
  { key: 'integrationHealthPct', label: 'Saúde das integrações', unit: '% (integrações verificadas)', fmt: (v: number) => fmtPct(v) },
  { key: 'openAlertsTotal', label: 'Alertas abertos', unit: 'alertas', fmt: (v: number) => fmtInt(v) },
] as const;

const LIFECYCLE_STATUS: Record<string, string> = { ACTIVE: 'NORMAL', ONBOARDING: 'ATTENTION', SUSPENDED: 'NO_DATA' };

export default function CompaniesComparisonPage() {
  const [range, setRange] = useState<CentralRange>('24h');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [severity, setSeverity] = useState('');
  const [sort, setSort] = useState('name');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [metric, setMetric] = useState<(typeof METRICS)[number]['key']>('requests');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    try {
      const res = await centralApi.companies({ range, q: debouncedQ, lifecycle, severity, sort, dir, page, limit: 20 });
      setData(res.data);
      setError(null);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar as empresas.'));
    } finally {
      setLoading(false);
    }
  }, [range, debouncedQ, lifecycle, severity, sort, dir, page]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const metricDef = METRICS.find((m) => m.key === metric)!;
  const rows: BarRow[] = useMemo(
    () => (data?.items ?? []).map((i: any) => ({ id: i.id, label: i.name, value: (i[metric] as number | null) ?? null })),
    [data, metric]
  );
  const toggleSort = (key: string) => {
    if (sort === key) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setDir(key === 'name' ? 'asc' : 'desc');
    }
    setPage(1);
  };
  const Th = ({ k, children, className = '' }: { k: string; children: React.ReactNode; className?: string }) => (
    <th className={`py-2 pr-3 font-medium ${className}`} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 hover:underline" onClick={() => toggleSort(k)} data-testid={`sort-${k}`}>
        {children}
        {sort === k && (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-6" data-testid="companies-comparison">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Monitoramento por empresa</h2>
          <p className="text-sm text-muted-foreground">Compare as empresas e abra o detalhe de cada uma: integrações, utilização, alertas e evolução.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <RangeSelector value={range} onChange={(r) => { setRange(r); setPage(1); }} />
          <Freshness generatedAt={data?.generatedAt} onRefresh={load} />
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-muted-foreground">
            Buscar por nome
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome da empresa" data-testid="filter-q" className="mt-1" />
          </label>
          <label className="text-xs text-muted-foreground">
            Situação
            <Select value={lifecycle} onChange={(e) => { setLifecycle(e.target.value); setPage(1); }} data-testid="filter-lifecycle" className="mt-1">
              <option value="">Todas</option>
              {Object.entries(LIFECYCLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Alertas abertos
            <Select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} data-testid="filter-severity" className="mt-1">
              <option value="">Qualquer</option>
              <option value="ANY">Com algum alerta</option>
              <option value="CRITICAL">Com alerta crítico</option>
              <option value="ATTENTION">Com alerta de atenção</option>
              <option value="OFFLINE">Com serviço fora do ar</option>
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            Indicador do gráfico
            <Select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)} data-testid="chart-metric" className="mt-1">
              {METRICS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </Select>
          </label>
        </CardContent>
      </Card>

      {error && <InlineError message={error} onRetry={load} />}
      {loading && !data ? (
        <LoadingState label="Carregando empresas..." />
      ) : (
        data && (
          <>
            <ChartCard testId="chart-companies" title={`Comparação: ${metricDef.label}`} unit={metricDef.unit} subtitle={`período: ${range} · ${data.items.length} empresa(s) desta página`} definition={metricDef.key === 'integrationHealthPct' ? data.definitions.integrationHealth : undefined}>
              <BarCompareChart rows={rows} title={metricDef.label} unit={metricDef.unit} formatValue={metricDef.fmt} />
            </ChartCard>

            <Card>
              <CardContent className="p-0">
                {data.items.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">Nenhuma empresa com estes filtros.</p>
                ) : (
                  <div className="overflow-x-auto p-4">
                    <table className="w-full text-sm" data-testid="companies-table">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <Th k="name">Empresa</Th>
                          <th className="py-2 pr-3 font-medium">Situação</th>
                          <Th k="branches">Filiais</Th>
                          <Th k="users">Usuários</Th>
                          <th className="py-2 pr-3 font-medium">Módulos</th>
                          <Th k="requests">Requisições</Th>
                          <Th k="errorPct">Erros 5xx</Th>
                          <Th k="p95Ms">p95</Th>
                          <Th k="integrationHealthPct">Integrações</Th>
                          <Th k="openAlerts">Alertas</Th>
                          <Th k="lastActivityAt">Última atividade</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.items.map((i: any) => (
                          <tr key={i.id} className="border-b last:border-0" data-testid={`company-row-${i.id}`}>
                            <td className="py-2 pr-3">
                              <Link href={`/dashboard/observability/empresas/${i.id}`} className="font-medium underline" data-testid={`company-link-${i.id}`}>
                                {i.name}
                              </Link>
                            </td>
                            <td className="py-2 pr-3">
                              <StatusPill status={LIFECYCLE_STATUS[i.lifecycle] ?? 'NO_DATA'} label={LIFECYCLE_LABEL[i.lifecycle] ?? i.lifecycle} />
                            </td>
                            <td className="py-2 pr-3 tabular-nums">{i.branches}</td>
                            <td className="py-2 pr-3 tabular-nums">{i.users}</td>
                            <td className="py-2 pr-3 tabular-nums">{i.modulesEnabled}/{i.modulesTotal}</td>
                            <td className="py-2 pr-3 tabular-nums">{fmtInt(i.requests)}</td>
                            <td className="py-2 pr-3 tabular-nums">{fmtPct(i.errorPct)}</td>
                            <td className="py-2 pr-3 tabular-nums">{fmtMs(i.p95Ms)}</td>
                            <td className="py-2 pr-3" data-testid={`company-integrations-${i.id}`}>
                              <span className="font-medium tabular-nums">{i.integrationHealthPct === null ? 'Sem dados' : fmtPct(i.integrationHealthPct)}</span>
                              <span className="block text-xs text-muted-foreground">
                                {i.integrations.verified} verif. · {i.integrations.error} erro · {i.integrations.notConfigured} não config.
                              </span>
                            </td>
                            <td className="py-2 pr-3">
                              {i.openAlertsTotal === 0 ? (
                                <span className="text-muted-foreground">nenhum</span>
                              ) : (
                                <Pill className={i.openAlerts.CRITICAL + i.openAlerts.OFFLINE > 0 ? 'bg-danger-soft text-danger border-danger/40' : 'bg-warning-soft text-warning border-warning/40'}>{i.openAlertsTotal} aberto(s)</Pill>
                              )}
                            </td>
                            <td className="py-2 whitespace-nowrap text-muted-foreground">{fmtAgo(i.lastActivityAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <Pagination page={data.page} pages={Math.max(1, Math.ceil(data.total / data.limit))} total={data.total} itemCount={data.items.length} onPageChange={setPage} itemLabel="empresas" />
              </CardContent>
            </Card>
          </>
        )
      )}
    </div>
  );
}
