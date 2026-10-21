'use client';

import type { ReactNode } from 'react';

// Dica dos gráficos: cartão do design system (superfície, borda e texto por token), sem o balão branco padrão da recharts.
// Uma linha por série; com uma só série mostra só o nome e o valor.
export interface ChartTooltipEntry {
  name?: string;
  dataKey?: string | number;
  value?: number | string | null;
  color?: string;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: string | number;
  formatLabel?: (label: string) => string;
  /** Recebe o valor e a chave da série (`dataKey`), para formatar cada série à sua maneira. */
  formatValue: (value: number, key: string) => string;
  /** Nome da série quando a recharts não o entrega (padrão: `name` do ponto). */
  seriesLabel?: string;
  /** Linhas extras sob as séries para o ponto sob o cursor (recebe a linha de dados do ponto); só mostra o que o chamador tiver de confiável. */
  details?: (row: any) => ReactNode;
}

export function ChartTooltip({ active, payload, label, formatLabel, formatValue, seriesLabel, details }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => p.value !== null && p.value !== undefined);
  if (rows.length === 0) return null;
  const title = label === undefined ? '' : formatLabel ? formatLabel(String(label)) : String(label);
  const multi = rows.length > 1;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-card-foreground shadow-sm">
      {title && <p className="font-medium text-foreground">{title}</p>}
      {rows.map((p, i) => (
        <p key={`${p.dataKey ?? p.name ?? i}`} className="mt-1 flex items-baseline gap-3 text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            {multi && p.color && <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />}
            {multi ? p.name : (seriesLabel ?? p.name)}
          </span>
          <span className="font-semibold text-foreground">{formatValue(Number(p.value), String(p.dataKey ?? p.name ?? ''))}</span>
        </p>
      ))}
      {details && (payload[0] as { payload?: unknown } | undefined)?.payload ? details((payload[0] as { payload?: unknown }).payload) : null}
    </div>
  );
}
