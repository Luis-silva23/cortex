'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { labelFormatter, toInstant } from '@/lib/chart-time';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { observabilityApi } from '@/lib/api';
import { LoadingState, ErrorState, EmptyState } from '../_components/states';
import { PeriodFilter, Period, presetToPeriod } from '../_components/period-filter';
import { formatDurationMs, formatPercent, formatBucketLabel } from '../_lib/format';

interface Metrics {
  requestCount: number;
  avgDurationMs: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  statusBreakdown: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
  requestsOverTime: Array<{ bucket: string; count: number }>;
  topSlowestRoutes: Array<{ route: string; avgDurationMs: number; count: number }>;
  topVolumeRoutes: Array<{ route: string; count: number }>;
  topErrorRoutes: Array<{ route: string; errorCount: number; errorRate: number }>;
}

// Cores do gráfico vêm dos tokens CÓRTEX: 2xx normal (verde), 3xx neutro (cinza), 4xx atenção (amarelo),
// 5xx crítico (vermelho) — verde/amarelo/vermelho só como status, nunca como cor decorativa.
const STATUS_COLORS: Record<string, string> = {
  '2xx': 'hsl(var(--success))',
  '3xx': 'hsl(var(--muted-foreground))',
  '4xx': 'hsl(var(--warning))',
  '5xx': 'hsl(var(--danger))',
};

export default function PerformancePage() {
  const [period, setPeriod] = useState<Period>(() => presetToPeriod(24, '24h'));
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    setError('');
    try {
      const res = await observabilityApi.getMetrics({
        startDate: p.startDate,
        endDate: p.endDate,
      });
      setData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar métricas de performance');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [period.startDate, period.endDate]);

  // Granularidade do rótulo (a mesma que a API usa para agrupar: hora até 48 h, dia acima disso) e a série em instantes, para o
  // gráfico temporal único (Linha por padrão, Colunas como alternativa).
  const bucketUnit: 'hour' | 'day' =
    new Date(period.endDate).getTime() - new Date(period.startDate).getTime() > 48 * 60 * 60 * 1000 ? 'day' : 'hour';
  const timeSeries = useMemo(() => {
    if (!data) return [];
    return data.requestsOverTime.map((row) => ({ t: toInstant(row.bucket), count: row.count }));
  }, [data]);

  const statusData = useMemo(() => {
    if (!data) return [];
    return (['2xx', '3xx', '4xx', '5xx'] as const).map((key) => ({
      name: key,
      count: data.statusBreakdown[key],
    }));
  }, [data]);

  return (
    <div className="space-y-6">
      <PeriodFilter period={period} onChange={setPeriod} />

      {loading ? (
        <LoadingState label="Carregando métricas de performance..." />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(period)} />
      ) : !data ? null : (
        <>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Requisições
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{data.requestCount}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">Média</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{formatDurationMs(data.avgDurationMs)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">P50</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{formatDurationMs(data.p50)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">P95</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{formatDurationMs(data.p95)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">P99</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{formatDurationMs(data.p99)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  Taxa de erro
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{formatPercent(data.errorRate)}</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Requisições ao longo do tempo</CardTitle>
              </CardHeader>
              <CardContent>
                {timeSeries.length === 0 ? (
                  <EmptyState message="Nenhuma requisição no período selecionado." />
                ) : (
                  <TimeSeriesChart
                    data={timeSeries}
                    series={[{ key: 'count', label: 'Requisições' }]}
                    title="Requisições ao longo do tempo"
                    height={260}
                    singlePointPadMs={bucketUnit === 'day' ? 86_400_000 : 3_600_000}
                    stepMs={bucketUnit === 'day' ? 86_400_000 : 3_600_000}
                    formatTick={(t) => formatBucketLabel(new Date(t), bucketUnit)}
                    formatLabel={labelFormatter}
                    formatValue={(v) => v.toLocaleString('pt-BR')}
                    formatAxis={(v) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Distribuição de status HTTP</CardTitle>
              </CardHeader>
              <CardContent>
                {data.requestCount === 0 ? (
                  <EmptyState message="Nenhuma requisição no período selecionado." />
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={statusData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="count">
                        {statusData.map((entry) => (
                          <Cell key={entry.name} fill={STATUS_COLORS[entry.name]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Rotas mais lentas</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.topSlowestRoutes.length === 0 ? (
                  <div className="p-4">
                    <EmptyState message="Sem dados no período." />
                  </div>
                ) : (
                  <RoutesTable
                    rows={data.topSlowestRoutes.map((r) => ({
                      route: r.route,
                      value: formatDurationMs(r.avgDurationMs),
                      extra: `${r.count} req.`,
                    }))}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Rotas com mais volume</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.topVolumeRoutes.length === 0 ? (
                  <div className="p-4">
                    <EmptyState message="Sem dados no período." />
                  </div>
                ) : (
                  <RoutesTable
                    rows={data.topVolumeRoutes.map((r) => ({
                      route: r.route,
                      value: `${r.count}`,
                      extra: 'req.',
                    }))}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Rotas com mais erros</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.topErrorRoutes.length === 0 ? (
                  <div className="p-4">
                    <EmptyState message="Nenhuma rota com erros no período." />
                  </div>
                ) : (
                  <RoutesTable
                    rows={data.topErrorRoutes.map((r) => ({
                      route: r.route,
                      value: `${r.errorCount}`,
                      extra: formatPercent(r.errorRate),
                    }))}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function RoutesTable({ rows }: { rows: Array<{ route: string; value: string; extra: string }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx} className="border-b last:border-0">
              <td className="px-4 py-2 text-sm font-mono">{row.route}</td>
              <td className="px-4 py-2 text-right text-sm font-medium">{row.value}</td>
              <td className="px-4 py-2 text-right text-xs text-muted-foreground">{row.extra}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
