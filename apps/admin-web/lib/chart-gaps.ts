// Períodos SEM DADO nos gráficos de evolução no tempo (decisão 59). A série só traz os instantes que existem; entre dois pontos
// separados por um ou mais intervalos vazios, uma linha reta sugeriria valores que ninguém mediu. Aqui cada lacuna vira um ponto
// sem valor, e a linha INTERROMPE nele. Nada é inventado: nenhum valor é preenchido, só se diz onde não há dado.

export interface GapPoint {
  /** Instante (ms desde 1970). */
  t: number;
  [key: string]: number | null | undefined;
}

/** Acima de 1,5 intervalo entre dois pontos consecutivos, há pelo menos um intervalo vazio entre eles. */
const GAP_FACTOR = 1.5;

/**
 * Devolve os pontos em ordem de tempo, com um ponto vazio (só `t`) logo depois de cada ponto que antecede uma lacuna.
 * `stepMs` é o intervalo do agrupamento da série (dia, hora, 15 min...). Sem `stepMs` válido, os pontos voltam como estão.
 */
export function breakAtGaps<T extends GapPoint>(points: T[], stepMs: number | undefined): Array<T | GapPoint> {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (!stepMs || !Number.isFinite(stepMs) || stepMs <= 0) return sorted;
  const out: Array<T | GapPoint> = [];
  sorted.forEach((p, i) => {
    out.push(p);
    const next = sorted[i + 1];
    if (next && next.t - p.t > stepMs * GAP_FACTOR) out.push({ t: p.t + stepMs });
  });
  return out;
}

/** Ponto sem nenhum valor numérico nas séries pedidas (os pontos vazios inseridos por `breakAtGaps`). */
export function isEmptyPoint(point: GapPoint | undefined, keys: string[]): boolean {
  return !point || keys.every((k) => point[k] === null || point[k] === undefined);
}
