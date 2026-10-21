'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_AXIS, CHART_CURSOR, CHART_GRID, CHART_PRIMARY } from '@/lib/chart-theme';
import { formatBRLCompact } from '@/lib/chart-format';
import { formatCurrency } from '@/lib/utils';
import { ChartTooltip } from './ChartTooltip';

export interface CategoryPoint {
  name: string;
  value: number;
}

// Comparação entre categorias (forma de pagamento, filial) = barras HORIZONTAIS: o nome da categoria fica legível por inteiro
// (na vertical, "Convênio empresa" e nomes de filial se escondiam uns aos outros). Uma cor só: a marca não tem paleta
// categórica, então a categoria vem do rótulo e não de uma cor por barra. Mesma grade, eixos e dica do gráfico de linha.
export function CategoryBarChart({
  data,
  height,
  seriesLabel = 'Total',
}: {
  data: CategoryPoint[];
  /** Padrão: cresce com o número de categorias (46 px cada). */
  height?: number;
  seriesLabel?: string;
}) {
  const h = height ?? Math.max(150, data.length * 46 + 40);
  return (
    <div role="img" aria-label={`${seriesLabel} por categoria: ${data.map((d) => d.name).join(', ')}`}>
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 4 }}>
          <CartesianGrid horizontal={false} stroke={CHART_GRID} />
          <XAxis
            type="number"
            tickFormatter={(v) => formatBRLCompact(Number(v))}
            tick={{ fill: CHART_AXIS, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={132}
            tick={{ fill: CHART_AXIS, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID }}
          />
          <Tooltip
            cursor={{ fill: CHART_CURSOR, fillOpacity: 0.6 }}
            content={<ChartTooltip formatValue={formatCurrency} seriesLabel={seriesLabel} />}
          />
          <Bar dataKey="value" name={seriesLabel} fill={CHART_PRIMARY} radius={[0, 3, 3, 0]} maxBarSize={22} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
