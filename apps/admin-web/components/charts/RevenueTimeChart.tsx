'use client';

import { dayLabel, dayLabelLong, dayToTime, timeToDay, formatBRLCompact } from '@/lib/chart-format';
import { formatCurrency } from '@/lib/utils';
import type { TimeChartMode } from '@/lib/chart-mode';
import { TimeSeriesChart } from './TimeSeriesChart';

export interface TimelinePoint {
  /** Dia local (YYYY-MM-DD), já agrupado pela API no fuso de Brasília. Só existem os dias com venda: nada é inventado. */
  date: string;
  total: number;
}

// Evolução da receita por dia = o gráfico temporal único (`TimeSeriesChart`: Linha por padrão, Colunas como alternativa) com a série
// de receita, o dia pronto da API (sem reconverter fuso) e moeda brasileira. Aqui só ficam os formatos desta série.
export function RevenueTimeChart({
  data,
  height = 280,
  seriesLabel = 'Receita',
  initialMode,
}: {
  data: TimelinePoint[];
  height?: number;
  seriesLabel?: string;
  initialMode?: TimeChartMode;
}) {
  const points = data.map((d) => ({ t: dayToTime(d.date), total: d.total }));
  return (
    <TimeSeriesChart
      data={points}
      series={[{ key: 'total', label: seriesLabel }]}
      title={`${seriesLabel} por dia (dias com vendas)`}
      // Um dia sem venda não é ponto: a linha interrompe nele em vez de ligar os dias com venda (decisão 59).
      stepMs={86_400_000}
      height={height}
      // Poucos dias: um rótulo por dia com venda; muitos: a biblioteca escolhe espaçamentos legíveis.
      ticks={points.length <= 10 ? points.map((p) => p.t) : undefined}
      formatTick={(t) => dayLabel(timeToDay(t))}
      formatLabel={(t) => dayLabelLong(timeToDay(t))}
      formatValue={(v) => formatCurrency(v)}
      formatAxis={formatBRLCompact}
      initialMode={initialMode}
      footnote={
        points.length === 1 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Há vendas em um único dia no período: {dayLabelLong(data[0].date)}, {formatCurrency(data[0].total)}. Uma linha precisa de pelo menos dois dias.
          </p>
        ) : undefined
      }
    />
  );
}
