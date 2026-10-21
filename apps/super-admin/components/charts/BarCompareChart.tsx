'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_AXIS, CHART_CURSOR, CHART_GRID, CHART_PRIMARY, CHART_SURFACE, CHART_TEXT } from '@/lib/chart-theme';

export interface BarRow {
  id: string;
  label: string;
  /** `null` = sem dado: a barra não existe e o nome aparece na nota "sem dado" (nunca vira zero). */
  value: number | null;
  /** Cor semântica opcional (token do tema), ex.: `hsl(var(--danger))`. Sem ela, a cor da marca. */
  color?: string;
}

/**
 * Barras para COMPARAR itens (empresas, categorias, meses). Horizontal por padrão (nomes longos legíveis), vertical para séries por mês. Título, unidade e valor sempre
 * escritos; itens sem dado ficam fora do desenho e listados abaixo. Mesmas cores e eixos do gráfico de linha do CÓRTEX.
 */
export function BarCompareChart({
  rows,
  title,
  unit,
  formatValue,
  layout = 'horizontal',
  height,
  testId,
}: {
  rows: BarRow[];
  title: string;
  unit: string;
  formatValue: (v: number) => string;
  layout?: 'horizontal' | 'vertical';
  height?: number;
  testId?: string;
}) {
  const withData = rows.filter((r) => r.value !== null && Number.isFinite(r.value));
  const without = rows.filter((r) => r.value === null);
  const h = height ?? (layout === 'horizontal' ? Math.max(120, withData.length * 34 + 40) : 260);
  return (
    <div data-testid={testId}>
      {withData.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nenhum item com dado neste período.</p>
      ) : (
        <div role="img" aria-label={`${title} (${unit}): ${withData.map((r) => `${r.label} ${formatValue(r.value as number)}`).join('; ')}`}>
          <ResponsiveContainer width="100%" height={h}>
            <BarChart data={withData} layout={layout === 'horizontal' ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 24, left: 8, bottom: 4 }}>
              <CartesianGrid stroke={CHART_GRID} horizontal={layout === 'vertical'} vertical={layout === 'horizontal'} />
              {layout === 'horizontal' ? (
                <>
                  <XAxis type="number" tick={{ fill: CHART_AXIS, fontSize: 12 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} tickFormatter={(v) => formatValue(Number(v))} />
                  <YAxis type="category" dataKey="label" width={150} tick={{ fill: CHART_TEXT, fontSize: 12 }} tickLine={false} axisLine={false} />
                </>
              ) : (
                <>
                  <XAxis dataKey="label" tick={{ fill: CHART_AXIS, fontSize: 12 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
                  <YAxis tick={{ fill: CHART_AXIS, fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={(v) => formatValue(Number(v))} width={56} />
                </>
              )}
              <Tooltip
                isAnimationActive={false}
                cursor={{ fill: CHART_CURSOR, fillOpacity: 0.6 }}
                formatter={(value: number) => [formatValue(Number(value)), unit]}
                contentStyle={{ background: CHART_SURFACE, border: `1px solid ${CHART_GRID}`, borderRadius: 8, color: CHART_TEXT, fontSize: 12 }}
                labelStyle={{ color: CHART_TEXT, fontWeight: 600 }}
              />
              <Bar dataKey="value" radius={layout === 'horizontal' ? [0, 3, 3, 0] : [3, 3, 0, 0]} isAnimationActive={false} maxBarSize={22}>
                {withData.map((r) => (
                  <Cell key={r.id} fill={r.color ?? CHART_PRIMARY} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {without.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Sem dado no período (fora do gráfico): {without.map((r) => r.label).join(', ')}.
        </p>
      )}
    </div>
  );
}
