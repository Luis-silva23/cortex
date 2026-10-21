import type { HealthStatus } from '@/lib/api';

// Cor só no indicador (ponto + texto), nunca no número: verde normal, amarelo atenção, vermelho crítico, cinza
// offline/sem dados.
const STYLE: Record<HealthStatus, { dot: string; label: string }> = {
  NORMAL: { dot: 'bg-success', label: 'Normal' },
  ATTENTION: { dot: 'bg-warning', label: 'Atenção' },
  CRITICAL: { dot: 'bg-danger', label: 'Crítico' },
  OFFLINE: { dot: 'bg-foreground/60', label: 'Offline' },
  NO_DATA: { dot: 'bg-muted-foreground/40', label: 'Sem dados' },
};

export function HealthBadge({ status }: { status: HealthStatus }) {
  const s = STYLE[status] ?? STYLE.NO_DATA;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
      <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export const COMPONENT_LABELS: Record<string, string> = {
  API: 'API',
  NETWORK: 'Rede',
  HOST: 'Servidor/equipamentos',
  DEVICES: 'Dispositivos',
};

export function formatDuration(from: string, to?: string | null) {
  const ms = new Date(to ?? Date.now()).getTime() - new Date(from).getTime();
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}
