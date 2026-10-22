import type { TimePoint } from '@/components/charts/TimeSeriesChart';

/**
 * Junta várias séries (cada uma com seus instantes) em UMA tabela por instante, para um gráfico com várias linhas. Instante que uma série não tem fica `null` (lacuna: o gráfico
 * interrompe a linha em vez de inventar valor). Usado pela Central e pela Infraestrutura.
 */
export function mergeSeries(parts: Array<{ key: string; rows: Array<{ t: number } & Record<string, any>>; field: string }>): TimePoint[] {
  const map = new Map<number, TimePoint>();
  for (const { key, rows, field } of parts) {
    for (const r of rows) {
      const row = map.get(r.t) ?? { t: r.t };
      row[key] = r[field] ?? null;
      map.set(r.t, row);
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}
