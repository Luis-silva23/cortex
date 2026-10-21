'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { observabilityApi } from '@/lib/api';
import { LoadingState, ErrorState } from '../_components/states';
import { SeverityBadge, StatusDot } from '../_components/severity-badge';
import { formatDateTime } from '../_lib/format';

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

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export default function HealthPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await observabilityApi.getHealth();
      setHealth(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar saúde da infraestrutura');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingState label="Verificando infraestrutura..." />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!health) return null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Status geral</CardTitle>
          <SeverityBadge severity={health.status === 'healthy' ? 'ok' : 'critical'} />
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm font-medium">Uptime do processo</p>
            <p className="text-sm text-muted-foreground">{formatUptime(health.uptime)}</p>
          </div>
          <div>
            <p className="text-sm font-medium">Verificado em</p>
            <p className="text-sm text-muted-foreground">{formatDateTime(health.timestamp)}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Serviços</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between border-b pb-3">
            <span className="text-sm font-medium">PostgreSQL</span>
            <StatusDot ok={health.services.database === 'connected'} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Redis</span>
            <StatusDot ok={health.services.redis === 'connected'} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workers (BullMQ)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {health.workers.map((worker, idx) => (
            <div
              key={worker.queue}
              className={`flex items-center justify-between ${idx < health.workers.length - 1 ? 'border-b pb-3' : ''}`}
            >
              <span className="text-sm font-medium">{worker.queue}</span>
              <StatusDot ok={worker.running} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status honesto de integrações</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between border-b pb-3">
            <span className="text-sm font-medium">Provedor de email</span>
            <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-800">
              {health.integrations.emailProvider}
            </span>
          </div>
          <div className="flex items-center justify-between border-b pb-3">
            <span className="text-sm font-medium">Gateway de pagamento</span>
            <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-800">
              {health.integrations.paymentGateway}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Configuração fiscal existe</span>
            <span
              className={`rounded-full px-2 py-1 text-xs font-medium ${
                health.integrations.fiscalConfigExists
                  ? 'bg-success-soft text-success'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {health.integrations.fiscalConfigExists ? 'Sim' : 'Não'}
            </span>
          </div>
          <p className="pt-2 text-xs text-muted-foreground">
            Estes valores refletem o estado real de integração da plataforma — não são
            reformulados para parecer mais avançados do que estão.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
