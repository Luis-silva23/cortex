'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { labelFormatter, tickFormatter, toInstant } from '@/lib/chart-time';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { monitoringApi, apiErrorMessage, type MonitoringRange, type MonitoringAlert } from '@/lib/api';
import { AlertList } from '../../../_components/alert-list';
import { ErrorState, LoadingState } from '../../../../observability/_components/states';
import { COMPONENT_LABELS, HealthBadge, formatDuration } from '../../../_components/health-badge';

const RANGES: Array<{ value: MonitoringRange; label: string }> = [
  { value: '1h', label: '1 hora' },
  { value: '6h', label: '6 horas' },
  { value: '24h', label: '24 horas' },
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
];

// Evolução no tempo: o gráfico único do CÓRTEX (Linha por padrão, Colunas como alternativa; mesmos dados, troca só visual). Os pontos
// chegam como instantes da API e são mostrados no fuso de Brasília; aqui só se adapta a série e o formato da unidade.
function Chart({ title, data, lines, range, unit, stepMs }: { title: string; data: any[]; lines: Array<{ key: string; label: string; color: string }>; range: MonitoringRange; unit: string; stepMs: number }) {
  const points = data.map((d) => ({ ...d, t: toInstant(d.t) }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Sem dados coletados no período.</p>
        ) : (
          <TimeSeriesChart
            data={points}
            series={lines}
            title={title}
            height={220}
            yWidth={56}
            singlePointPadMs={3_600_000}
            stepMs={stepMs}
            formatTick={tickFormatter(range === '7d' || range === '30d')}
            formatLabel={labelFormatter}
            formatValue={(v) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}${unit}`}
            formatAxis={(v) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}${unit}`}
          />
        )}
      </CardContent>
    </Card>
  );
}

// Empresa → Filial → Monitoramento: estado atual, histórico em gráficos, endpoints, dispositivos e incidentes.
export default function BranchMonitoringPage() {
  const { id, branchId } = useParams<{ id: string; branchId: string }>();
  const [range, setRange] = useState<MonitoringRange>('24h');
  const [health, setHealth] = useState<any>(null);
  const [series, setSeries] = useState<any>(null);
  const [endpoints, setEndpoints] = useState<any[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<MonitoringAlert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [h, s, e, i, a] = await Promise.all([
        monitoringApi.branchHealth(id, branchId),
        monitoringApi.series(id, branchId, range),
        monitoringApi.endpoints(id, branchId, range),
        monitoringApi.incidents(id, branchId),
        monitoringApi.alerts(id, { branchId }),
      ]);
      setHealth(h.data);
      setSeries(s.data);
      setEndpoints(e.data.endpoints ?? []);
      setIncidents(i.data.incidents ?? []);
      setAlerts((a.data.alerts ?? []).slice(0, 30));
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar o monitoramento da filial.'));
    } finally {
      setLoading(false);
    }
  }, [id, branchId, range]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!health) return null;

  // Intervalo do agrupamento da série (a API devolve em segundos): intervalo sem dado interrompe a linha (decisão 59).
  const stepMs = (series?.bucketSec ?? 0) * 1000;
  const primary = 'hsl(var(--primary))';
  const muted = 'hsl(var(--muted-foreground))';
  const danger = 'hsl(var(--danger))';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href={`/dashboard/companies/${id}/health`} aria-label="Voltar para a empresa">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{health.branch.name}</h1>
            <p className="text-sm text-muted-foreground">Monitoramento da filial</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HealthBadge status={health.status} />
          <div role="group" aria-label="Período" className="flex flex-wrap gap-1 rounded-md border border-border p-1">
            {RANGES.map((r) => (
              <Button key={r.value} size="sm" variant={r.value === range ? 'default' : 'ghost'} aria-pressed={r.value === range} onClick={() => setRange(r.value)}>
                {r.label}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Atualizar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">API (últimos 15 min)</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <HealthBadge status={health.api.status} />
            <p className="text-xl font-semibold text-foreground">{health.api.p95Ms ?? '—'} ms p95</p>
            <p className="text-xs text-muted-foreground">{health.api.requests} requisições · {health.api.errorRatePct ?? '—'}% com erro 5xx</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Rede (equipamentos → API)</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <HealthBadge status={health.network.status} />
            <p className="text-xl font-semibold text-foreground">{health.network.rttMs ?? '—'} ms</p>
            <p className="text-xs text-muted-foreground">Perda de pacotes: {health.network.lossPct ?? '—'}% · Wi-Fi: não coletado</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Servidor/equipamentos</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <HealthBadge status={health.host.status} />
            <p className="text-xl font-semibold text-foreground">CPU {health.host.cpuPct ?? '—'}%</p>
            <p className="text-xs text-muted-foreground">RAM {health.host.memPct ?? '—'}% · disco {health.host.diskPct ?? '—'}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Dispositivos</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <HealthBadge status={health.devices.status} />
            <p className="text-xl font-semibold text-foreground">{health.devices.online}/{health.devices.total} online</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Chart title="Latência da API" data={series?.api ?? []} range={range} stepMs={stepMs} unit=" ms" lines={[{ key: 'p95Ms', label: 'p95', color: primary }, { key: 'avgMs', label: 'média', color: muted }]} />
        <Chart title="Requisições e erros" data={series?.api ?? []} range={range} stepMs={stepMs} unit="" lines={[{ key: 'requests', label: 'requisições', color: primary }, { key: 'errors', label: 'erros 5xx', color: danger }]} />
        <Chart title="CPU, RAM e disco" data={series?.telemetry ?? []} range={range} stepMs={stepMs} unit="%" lines={[{ key: 'cpuPct', label: 'CPU', color: primary }, { key: 'memPct', label: 'RAM', color: muted }, { key: 'diskPct', label: 'disco', color: 'hsl(var(--warning))' }]} />
        <Chart title="Rede: latência e perda" data={series?.telemetry ?? []} range={range} stepMs={stepMs} unit="" lines={[{ key: 'rttMs', label: 'latência (ms)', color: primary }, { key: 'lossPct', label: 'perda (%)', color: danger }]} />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Endpoints (mais lentos primeiro)</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {endpoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma requisição no período.</p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Endpoint</th>
                  <th className="py-2 pr-4 font-medium">Requisições</th>
                  <th className="py-2 pr-4 font-medium">Média</th>
                  <th className="py-2 pr-4 font-medium">p95</th>
                  <th className="py-2 pr-4 font-medium">Erros 5xx</th>
                  <th className="py-2 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((e) => (
                  <tr key={`${e.method} ${e.route}`} className="border-b border-border last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs text-foreground">{e.method} {e.route}</td>
                    <td className="py-2 pr-4 text-foreground">{e.requests}</td>
                    <td className="py-2 pr-4 text-foreground">{e.avgMs} ms</td>
                    <td className="py-2 pr-4 text-foreground">{e.p95Ms} ms</td>
                    <td className="py-2 pr-4 text-foreground">{e.errorRatePct}%</td>
                    <td className="py-2"><HealthBadge status={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Dispositivos</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {health.devices.list.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum equipamento com sessão ou telemetria nesta filial.</p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Equipamento</th>
                  <th className="py-2 pr-4 font-medium">Versão</th>
                  <th className="py-2 pr-4 font-medium">Último contato</th>
                  <th className="py-2 pr-4 font-medium">CPU / RAM / disco</th>
                  <th className="py-2 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {health.devices.list.map((d: any) => (
                  <tr key={d.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-4 text-foreground">{d.name}</td>
                    <td className="py-2 pr-4 text-foreground">
                      {d.appVersion ?? '—'}
                      {d.runtimeVersion && <span className="block text-xs text-muted-foreground">{d.runtimeVersion}</span>}
                    </td>
                    <td className="py-2 pr-4 text-foreground">{d.lastContactAt ? new Date(d.lastContactAt).toLocaleString('pt-BR') : 'nunca'}</td>
                    <td className="py-2 pr-4 text-foreground">{d.cpuPct ?? '—'}% / {d.memPct ?? '—'}% / {d.diskPct ?? '—'}%</td>
                    <td className="py-2"><HealthBadge status={d.online ? 'NORMAL' : 'OFFLINE'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Alertas</CardTitle></CardHeader>
        <CardContent>
          <AlertList
            alerts={alerts}
            deviceName={(deviceId) => health?.devices?.list?.find((d: any) => d.id === deviceId)?.name ?? null}
            empty="Nenhum alerta registrado nesta filial."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Histórico de saúde</CardTitle></CardHeader>
        <CardContent>
          {incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum incidente registrado nesta filial.</p>
          ) : (
            <ul className="divide-y divide-border">
              {incidents.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="flex flex-wrap items-center gap-3">
                    <HealthBadge status={i.status} />
                    <span className="text-foreground">{COMPONENT_LABELS[i.component] ?? i.component}</span>
                    <span className="text-muted-foreground">{i.detail}</span>
                  </span>
                  <span className="text-muted-foreground">
                    começou {new Date(i.startedAt).toLocaleString('pt-BR')} ·{' '}
                    {i.endedAt
                      ? `normalizou ${new Date(i.endedAt).toLocaleString('pt-BR')} (durou ${formatDuration(i.startedAt, i.endedAt)})`
                      : `em aberto há ${formatDuration(i.startedAt)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
