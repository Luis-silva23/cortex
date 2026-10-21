// Estados de saúde do monitoramento. NO_DATA = sem coleta (cinza na tela), nunca "normal" por falta de dado.
export type HealthStatus = 'NORMAL' | 'ATTENTION' | 'CRITICAL' | 'OFFLINE' | 'NO_DATA';

export type Threshold = { attention: number; critical: number };

// Limites por métrica (valor >= limite muda o estado). Padrões do produto; ver docs de monitoramento.
export const THRESHOLDS = {
  apiP95Ms: { attention: 800, critical: 2000 },
  api5xxPct: { attention: 1, critical: 5 },
  cpuPct: { attention: 80, critical: 95 },
  memPct: { attention: 85, critical: 95 },
  diskPct: { attention: 85, critical: 95 },
  rttMs: { attention: 300, critical: 1000 },
  lossPct: { attention: 2, critical: 10 },
} as const satisfies Record<string, Threshold>;

// Equipamento sem heartbeat/telemetria há mais que isto deixa de ser considerado online.
export const DEVICE_ONLINE_WINDOW_MS = 3 * 60_000;

export function level(value: number | null | undefined, t: Threshold): HealthStatus {
  if (value === null || value === undefined || Number.isNaN(value)) return 'NO_DATA';
  if (value >= t.critical) return 'CRITICAL';
  if (value >= t.attention) return 'ATTENTION';
  return 'NORMAL';
}

const SEVERITY: Record<HealthStatus, number> = { NO_DATA: 0, NORMAL: 1, ATTENTION: 2, CRITICAL: 3, OFFLINE: 4 };

/** Pior estado entre os informados; NO_DATA só se nenhum tiver dado. */
export function worst(...statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((acc, s) => (SEVERITY[s] > SEVERITY[acc] ? s : acc), 'NO_DATA');
}

/** % offline: ATENÇÃO a partir de `attention`; CRÍTICO quando MAIS que `critical` (padrão: mais da metade). */
export function devicesStatus(online: number, total: number, t: Threshold = { attention: 1, critical: 50 }): HealthStatus {
  if (total === 0) return 'NO_DATA';
  if (online === 0) return 'OFFLINE';
  const offline = total - online;
  const pct = (offline / total) * 100;
  if (pct > t.critical) return 'CRITICAL';
  if (offline > 0 && pct >= t.attention) return 'ATTENTION';
  return 'NORMAL';
}
