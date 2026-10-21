'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CHART_COLORS, CHART_SURFACE } from '@/lib/chart-theme';

// Composição de um total (ex.: receita por origem de venda). A marca não tem paleta categórica: as fatias usam tons da mesma
// família do tema, separadas por um fio da cor da superfície; quem lê os valores exatos é a tabela ao lado (o gráfico nunca vai
// sozinho). Fatias zeradas não são desenhadas.
export const DONUT_COLORS = [CHART_COLORS[0], CHART_COLORS[3], CHART_COLORS[4], CHART_COLORS[2], CHART_COLORS[5], CHART_COLORS[1]] as const;
export const donutColor = (index: number): string => DONUT_COLORS[index % DONUT_COLORS.length];

export interface DonutSlice {
  key: string;
  name: string;
  value: number;
}

export function DonutChart({
  slices,
  total,
  centerLabel,
  centerValue,
  formatValue,
  height = 200,
  ariaLabel,
}: {
  slices: DonutSlice[];
  total: number;
  centerLabel: string;
  centerValue: string;
  formatValue: (value: number) => string;
  height?: number;
  ariaLabel: string;
}) {
  const drawn = slices.map((s, i) => ({ ...s, color: donutColor(i) })).filter((s) => s.value > 0);
  return (
    <div role="img" aria-label={ariaLabel} className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip
            isAnimationActive={false}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as (DonutSlice & { color: string }) | undefined) : undefined;
              if (!p) return null;
              return (
                <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-card-foreground shadow-sm">
                  <p className="inline-flex items-center gap-2 font-medium text-foreground">
                    <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
                    {p.name}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {formatValue(p.value)} <span className="font-semibold text-foreground">({total > 0 ? ((p.value / total) * 100).toFixed(1).replace('.', ',') : '0'}%)</span>
                  </p>
                </div>
              );
            }}
          />
          <Pie data={drawn} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={drawn.length > 1 ? 2 : 0} stroke={CHART_SURFACE} strokeWidth={2} isAnimationActive={false}>
            {drawn.map((s) => (
              <Cell key={s.key} fill={s.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-xs text-muted-foreground">{centerLabel}</span>
        <span className="text-base font-semibold text-foreground">{centerValue}</span>
      </div>
    </div>
  );
}
