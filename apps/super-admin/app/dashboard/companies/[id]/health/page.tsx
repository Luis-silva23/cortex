'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { monitoringApi, apiErrorMessage, type HealthStatus, type MonitoringAlert } from '@/lib/api';
import { AlertList } from '../../_components/alert-list';
import { ErrorState, LoadingState, EmptyState } from '../../../observability/_components/states';
import { COMPONENT_LABELS, HealthBadge, formatDuration } from '../../_components/health-badge';

type BranchRow = {
  id: string;
  name: string;
  status: HealthStatus;
  api: HealthStatus;
  network: HealthStatus;
  host: HealthStatus;
  devices: { status: HealthStatus; online: number; total: number };
};

// Empresas → empresa: saúde consolidada (infra central + filiais). Dados reais; "Sem dados" quando não há coleta.
export default function CompanyHealthPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<MonitoringAlert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [health, inc, companyAlerts, centralAlerts] = await Promise.all([
        monitoringApi.companyHealth(id),
        monitoringApi.incidents(id),
        monitoringApi.alerts(id, { open: true }),
        monitoringApi.centralAlerts(true),
      ]);
      setData(health.data);
      setIncidents(inc.data.incidents ?? []);
      setAlerts([...(centralAlerts.data.alerts ?? []), ...(companyAlerts.data.alerts ?? [])]);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar a saúde da empresa.'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <EmptyState message="Empresa não encontrada." />;

  const central = data.central;
  const branchName = (branchId: string) => data.branches.find((b: BranchRow) => b.id === branchId)?.name ?? '—';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/companies" aria-label="Voltar para Empresas">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{data.company.name}</h1>
            <p className="text-sm text-muted-foreground">
              Saúde da empresa — atualizado {new Date(data.generatedAt).toLocaleTimeString('pt-BR')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <HealthBadge status={data.status} />
          <Link href={`/dashboard/companies/${id}/thresholds`}>
            <Button variant="outline" size="sm">
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              Limites
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Atualizar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Banco de dados (PostgreSQL)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <HealthBadge status={central.database.status} />
            <p className="text-xl font-semibold text-foreground">{central.database.latencyMs ?? '—'} ms</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Cache (Redis)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <HealthBadge status={central.redis.status} />
            <p className="text-xl font-semibold text-foreground">{central.redis.latencyMs ?? '—'} ms</p>
            <p className="text-xs text-muted-foreground">Memória: {central.redis.memoryMb ?? '—'} MB</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Filas e jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <HealthBadge status={central.queues.status} />
            <p className="text-xl font-semibold text-foreground">{central.queues.waiting} pendentes</p>
            <p className="text-xs text-muted-foreground">
              {central.queues.failedLastHour ?? 0} com falha na última hora · {central.queues.failed} retidas ·{' '}
              {central.queues.workersDown} worker(s) parados · {central.queues.overdue ?? 0} agendado(s) atrasado(s)
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alertas ativos</CardTitle>
        </CardHeader>
        <CardContent>
          <AlertList alerts={alerts} branchName={(b) => (b ? branchName(b) : '—')} empty="Nenhum alerta ativo." />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filiais</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {data.branches.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma filial ativa.</p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Filial</th>
                  <th className="py-2 pr-4 font-medium">API</th>
                  <th className="py-2 pr-4 font-medium">Rede</th>
                  <th className="py-2 pr-4 font-medium">Servidor</th>
                  <th className="py-2 pr-4 font-medium">Dispositivos</th>
                  <th className="py-2 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {data.branches.map((b: BranchRow) => (
                  <tr key={b.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/dashboard/companies/${id}/branches/${b.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {b.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4"><HealthBadge status={b.api} /></td>
                    <td className="py-2 pr-4"><HealthBadge status={b.network} /></td>
                    <td className="py-2 pr-4"><HealthBadge status={b.host} /></td>
                    <td className="py-2 pr-4 text-foreground">{b.devices.total ? `${b.devices.online}/${b.devices.total}` : '—'}</td>
                    <td className="py-2"><HealthBadge status={b.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Incidentes recentes</CardTitle>
        </CardHeader>
        <CardContent>
          {incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum incidente registrado.</p>
          ) : (
            <ul className="divide-y divide-border">
              {incidents.slice(0, 20).map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="flex flex-wrap items-center gap-3">
                    <HealthBadge status={i.status} />
                    <span className="text-foreground">
                      {branchName(i.branchId)} · {COMPONENT_LABELS[i.component] ?? i.component}
                    </span>
                    <span className="text-muted-foreground">{i.detail}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(i.startedAt).toLocaleString('pt-BR')} ·{' '}
                    {i.endedAt ? `normalizou após ${formatDuration(i.startedAt, i.endedAt)}` : `em aberto há ${formatDuration(i.startedAt)}`}
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
