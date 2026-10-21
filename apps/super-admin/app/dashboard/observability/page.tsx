'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { observabilityApi } from '@/lib/api';
import { LoadingState, ErrorState, EmptyState } from './_components/states';
import { SeverityBadge, StatusDot } from './_components/severity-badge';
import { Activity, Database, Server, Shield, Zap, ScrollText } from 'lucide-react';

interface Alert {
  id: string;
  name: string;
  severity: 'ok' | 'warning' | 'critical';
  currentValue: number;
  threshold: number;
  message: string;
}

interface Health {
  status: string;
  timestamp: string;
  uptime: number;
  services: { database: string; redis: string };
  workers: Array<{ queue: string; running: boolean }>;
  integrations: {
    emailProvider: string;
    paymentGateway: string;
    fiscalConfigExists: boolean;
  };
}

const quickLinks = [
  { name: 'Performance', href: '/dashboard/observability/performance', icon: Zap, description: 'Latência, throughput e rotas' },
  { name: 'Segurança', href: '/dashboard/observability/security', icon: Shield, description: 'Logins falhos, IPs e eventos' },
  { name: 'Infraestrutura', href: '/dashboard/observability/health', icon: Server, description: 'Banco, Redis e workers' },
  { name: 'Integrações', href: '/dashboard/observability/integrations', icon: Database, description: 'Pagamentos e documentos fiscais' },
  { name: 'Jobs', href: '/dashboard/observability/jobs', icon: Activity, description: 'Filas BullMQ e falhas' },
  { name: 'Logs', href: '/dashboard/observability/logs', icon: ScrollText, description: 'Logs do sistema e requisições' },
];

export default function ObservabilityOverviewPage() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [alertsRes, healthRes] = await Promise.all([
        observabilityApi.getAlerts(),
        observabilityApi.getHealth(),
      ]);
      setAlerts(alertsRes.data);
      setHealth(healthRes.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar dados de observabilidade');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingState label="Carregando observabilidade..." />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const criticalCount = alerts?.filter((a) => a.severity === 'critical').length || 0;
  const warningCount = alerts?.filter((a) => a.severity === 'warning').length || 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Alertas ativos</h2>
        <p className="text-sm text-muted-foreground">
          {criticalCount > 0
            ? `${criticalCount} alerta(s) crítico(s) requerem atenção imediata`
            : warningCount > 0
              ? `${warningCount} alerta(s) em atenção`
              : 'Nenhum alerta crítico no momento'}
        </p>
      </div>

      {!alerts || alerts.length === 0 ? (
        <EmptyState message="Nenhum alerta configurado retornou dados." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {alerts.map((alert) => (
            <Card
              key={alert.id}
              className={
                alert.severity === 'critical'
                  ? 'border-danger/40'
                  : alert.severity === 'warning'
                    ? 'border-warning/40'
                    : undefined
              }
            >
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{alert.name}</CardTitle>
                <SeverityBadge severity={alert.severity} />
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{alert.message}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Resumo de saúde</h2>
        {!health ? (
          <EmptyState message="Não foi possível carregar o resumo de saúde." />
        ) : (
          <Card>
            <CardContent className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-sm font-medium">Status geral</p>
                <SeverityBadge
                  severity={health.status === 'healthy' ? 'ok' : 'critical'}
                  className="mt-1"
                />
              </div>
              <div>
                <p className="text-sm font-medium">Banco de dados</p>
                <div className="mt-1">
                  <StatusDot ok={health.services.database === 'connected'} />
                </div>
              </div>
              <div>
                <p className="text-sm font-medium">Redis</p>
                <div className="mt-1">
                  <StatusDot ok={health.services.redis === 'connected'} />
                </div>
              </div>
              <div>
                <p className="text-sm font-medium">Workers ativos</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {health.workers.filter((w) => w.running).length} / {health.workers.length}
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Áreas de observabilidade</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {quickLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              <Card className="h-full transition-colors hover:bg-accent/50">
                <CardContent className="flex items-start gap-3 p-4">
                  <link.icon className="mt-0.5 h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{link.name}</p>
                    <p className="text-xs text-muted-foreground">{link.description}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
