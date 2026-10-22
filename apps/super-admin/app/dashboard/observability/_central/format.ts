import type { CentralRange } from '@/lib/api';
import { APP_TIME_ZONE } from '@/lib/chart-time';

// Formatação e rótulos da Central de Monitoramento. Tudo em pt-BR e no fuso do produto; "sem dado" é sempre um traço, nunca zero.
export const RANGE_OPTIONS: Array<{ key: CentralRange; label: string }> = [
  { key: '1h', label: '1 hora' },
  { key: '6h', label: '6 horas' },
  { key: '24h', label: '24 horas' },
  { key: '7d', label: '7 dias' },
  { key: '30d', label: '30 dias' },
];

export const isLongRange = (range: CentralRange) => range === '7d' || range === '30d';
export const RANGE_STEP_MS: Record<CentralRange, number> = { '1h': 60_000, '6h': 300_000, '24h': 900_000, '7d': 3_600_000, '30d': 21_600_000 };

export const fmtInt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('pt-BR'));
export const fmtPct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`);
export const fmtMs = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s`);
export const fmtDateTime = (iso: string | Date | null | undefined) => {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { timeZone: APP_TIME_ZONE });
};
export const fmtTime = (iso: string | Date | null | undefined) => {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('pt-BR', { timeZone: APP_TIME_ZONE });
};
export const fmtBytes = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1_048_576) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1_048_576).toFixed(1)} MB`;
};
/** Duração legível de um incidente: "45 s", "12 min", "3 h 20 min", "2 d 4 h". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
export function fmtAgo(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return 'sem registro';
  const t = (typeof iso === 'string' ? new Date(iso) : iso).getTime();
  if (Number.isNaN(t)) return 'sem registro';
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return 'agora há pouco';
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} d`;
}

// ---- estados (cor só como sinal semântico; o TEXTO sempre diz o estado) ----
export const STATUS_LABEL: Record<string, string> = { NORMAL: 'Normal', ATTENTION: 'Atenção', CRITICAL: 'Crítico', OFFLINE: 'Fora do ar', NO_DATA: 'Sem dados' };
export const STATUS_STYLE: Record<string, string> = {
  NORMAL: 'bg-success-soft text-success border-success/40',
  ATTENTION: 'bg-warning-soft text-warning border-warning/40',
  CRITICAL: 'bg-danger-soft text-danger border-danger/40',
  OFFLINE: 'bg-danger-soft text-danger border-danger/40',
  NO_DATA: 'bg-muted text-muted-foreground border-border',
};
export const SEVERITY_LABEL: Record<string, string> = { ATTENTION: 'Atenção', CRITICAL: 'Crítico', OFFLINE: 'Fora do ar' };

export const ALERT_STATUS_LABEL: Record<string, string> = { OPEN: 'Aberto', ACKNOWLEDGED: 'Reconhecido', IN_PROGRESS: 'Em tratamento', RESOLVED: 'Resolvido' };
export const ALERT_STATUS_STYLE: Record<string, string> = {
  OPEN: 'bg-danger-soft text-danger border-danger/40',
  ACKNOWLEDGED: 'bg-warning-soft text-warning border-warning/40',
  IN_PROGRESS: 'bg-muted text-foreground border-border',
  RESOLVED: 'bg-success-soft text-success border-success/40',
};
export const CATEGORY_LABEL: Record<string, string> = {
  DATABASE: 'Banco de dados',
  REDIS: 'Redis',
  QUEUES: 'Filas e jobs',
  API: 'API',
  HOST: 'Servidor',
  NETWORK: 'Rede',
  DEVICE: 'Equipamentos',
  BACKUP: 'Backup',
  INTEGRATION: 'Integrações',
  NOTIFICATION: 'Notificações',
  EXTERNAL: 'Monitor externo',
  OTHER: 'Outros',
};
export const EVENT_LABEL: Record<string, string> = {
  OPENED: 'Alerta aberto',
  REOPENED: 'Reaberto',
  SEVERITY_CHANGED: 'Gravidade alterada',
  ACKNOWLEDGED: 'Reconhecido',
  ASSIGNED: 'Responsável',
  IN_PROGRESS: 'Em tratamento',
  RESOLVED: 'Resolvido',
  AUTO_RESOLVED: 'Normalizou sozinho',
  NOTE: 'Anotação',
  NOTIFIED: 'Aviso por e-mail enviado',
  NOTIFICATION_SUPPRESSED: 'Aviso por e-mail suprimido',
  NOTIFICATION_FAILED: 'Aviso por e-mail falhou',
};
export const INTEGRATION_STATE_LABEL: Record<string, string> = { HEALTHY: 'Saudável', DEGRADED: 'Degradada', ERROR: 'Com erro', NOT_VERIFIED: 'Não verificada', NOT_CONFIGURED: 'Não configurada', DISABLED: 'Desativada' };
export const INTEGRATION_STATE_STYLE: Record<string, string> = {
  HEALTHY: 'bg-success-soft text-success border-success/40',
  DEGRADED: 'bg-warning-soft text-warning border-warning/40',
  ERROR: 'bg-danger-soft text-danger border-danger/40',
  NOT_VERIFIED: 'bg-muted text-muted-foreground border-border',
  NOT_CONFIGURED: 'bg-muted text-muted-foreground border-border',
  DISABLED: 'bg-muted text-muted-foreground border-border',
};
export const LIFECYCLE_LABEL: Record<string, string> = { ACTIVE: 'Ativa', ONBOARDING: 'Em implantação', SUSPENDED: 'Suspensa' };
export const EXTERNAL_STATE_LABEL: Record<string, string> = { ACTIVE: 'Ativo', DISABLED: 'Desligado', PENDING_CONFIGURATION: 'Pendente de configuração', INVALID: 'Configuração inválida' };
export const MODULE_LABEL: Record<string, string> = { ESTOQUE: 'Estoque', COMPRAS: 'Compras', VENDAS: 'Vendas', FINANCEIRO: 'Financeiro', FISCAL: 'Fiscal', OFICINA: 'Oficina', POS_VENDA: 'Pós-venda', CANAIS: 'Canais' };
export const USER_TYPE_LABEL: Record<string, string> = { COMPANY_ADMIN: 'Administradores', MANAGER: 'Gerentes', OPERATOR: 'Operadores', MECHANIC: 'Mecânicos', VIEWER: 'Visualizadores', SUPER_ADMIN: 'Super Admin' };

/** Estado de um percentual de disponibilidade: ≥ 99% normal, ≥ 95% atenção, abaixo crítico; sem dado fica sem dados. */
export function availabilityStatus(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'NO_DATA';
  return pct >= 99 ? 'NORMAL' : pct >= 95 ? 'ATTENTION' : 'CRITICAL';
}
export function healthPctStatus(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'NO_DATA';
  return pct >= 90 ? 'NORMAL' : pct >= 60 ? 'ATTENTION' : 'CRITICAL';
}
