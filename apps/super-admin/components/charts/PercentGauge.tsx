'use client';

import { cn } from '@/lib/utils';

/**
 * Indicador percentual (0–100) como barra: a largura é o valor e o NÚMERO é sempre escrito (a cor sozinha não diz nada). Sem dado (`null`) mostra "Sem dados"
 * com a barra vazia — nunca 0% nem 100% por falta de informação. Cor só como sinal semântico, passada pelo chamador (`tone`).
 */
export function PercentGauge({
  value,
  label,
  tone = 'neutral',
  emptyLabel = 'Sem dados',
  testId,
}: {
  value: number | null | undefined;
  label: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
  emptyLabel?: string;
  testId?: string;
}) {
  const has = value !== null && value !== undefined && Number.isFinite(value);
  const pct = has ? Math.min(100, Math.max(0, value as number)) : 0;
  const bar = tone === 'good' ? 'bg-success' : tone === 'warn' ? 'bg-warning' : tone === 'bad' ? 'bg-danger' : 'bg-primary';
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm font-semibold tabular-nums">{has ? `${(value as number).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : emptyLabel}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={has ? pct : undefined}
        aria-valuetext={has ? `${pct}%` : emptyLabel}
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full transition-all', bar)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
