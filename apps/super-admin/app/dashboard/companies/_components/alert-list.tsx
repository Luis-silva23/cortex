'use client';

import type { MonitoringAlert } from '@/lib/api';
import { HealthBadge, formatDuration } from './health-badge';

export const ALERT_LABELS: Record<string, string> = {
  API_LATENCY: 'Latência da API elevada',
  API_ERRORS: 'API degradada (erros 5xx)',
  HOST_CPU: 'CPU crítica',
  HOST_MEMORY: 'RAM crítica',
  HOST_DISK: 'Disco crítico',
  NETWORK_LATENCY: 'Internet degradada (latência)',
  NETWORK_LOSS: 'Perda de pacotes',
  DEVICE_OFFLINE: 'Equipamento sem comunicação',
  DATABASE_DEGRADED: 'Banco de dados degradado',
  REDIS_DEGRADED: 'Cache (Redis) degradado',
  QUEUE_BACKLOG: 'Fila acumulada',
  QUEUE_FAILURES: 'Jobs com falha',
  QUEUE_WORKER_DOWN: 'Worker de fila parado',
  JOB_OVERDUE: 'Jobs agendados atrasados',
};

/** Lista de alertas: origem, alvo, valor × limite, início e duração. Cor só no selo de estado. */
export function AlertList({ alerts, branchName, deviceName, empty }: {
  alerts: MonitoringAlert[];
  branchName?: (id: string | null) => string;
  deviceName?: (id: string | null) => string | null;
  empty: string;
}) {
  if (alerts.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {alerts.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <span className="flex flex-wrap items-center gap-3">
            <HealthBadge status={a.severity} />
            <span className="text-foreground">
              {ALERT_LABELS[a.type] ?? a.type}
              {a.source === 'CENTRAL' ? ' · infraestrutura central' : branchName ? ` · ${branchName(a.branchId)}` : ''}
              {a.deviceId && deviceName?.(a.deviceId) ? ` · ${deviceName(a.deviceId)}` : ''}
            </span>
            <span className="text-muted-foreground">
              {a.detail}
              {a.threshold !== null && a.value !== null ? ` (limite ${a.threshold})` : ''}
              {a.occurrences > 1 ? ` · ${a.occurrences} ocorrências` : ''}
            </span>
          </span>
          <span className="text-muted-foreground">
            {new Date(a.startedAt).toLocaleString('pt-BR')} ·{' '}
            {a.endedAt ? `normalizou após ${formatDuration(a.startedAt, a.endedAt)}` : `em aberto há ${formatDuration(a.startedAt)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
