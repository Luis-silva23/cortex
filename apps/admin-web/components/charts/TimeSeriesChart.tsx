'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_AXIS, CHART_CURSOR, CHART_GRID, CHART_PRIMARY, CHART_SURFACE } from '@/lib/chart-theme';
import { DEFAULT_TIME_CHART_MODE, TIME_CHART_MODES, type TimeChartMode } from '@/lib/chart-mode';
import { breakAtGaps, isEmptyPoint } from '@/lib/chart-gaps';
import { ChartTooltip } from './ChartTooltip';
import { ChartModeToggle } from './ChartModeToggle';

// ÚNICO gráfico de evolução no tempo do CÓRTEX (Admin Web e Super Admin usam este mesmo arquivo; `lib/chart-parity.test.ts` impede
// que as duas cópias divirjam). O perfil de acesso só decide QUAIS dados chegam; o desenho é o mesmo para CEO, Administrador,
// Gerente e Super Admin. LINHA é o padrão; COLUNAS é a alternativa, pelo mesmo controle: mesma série, mesmo período e mesmos filtros,
// troca só de estado local (sem nova chamada ao servidor, sem recarregar).
//   Linha: segmentos retos (suavizar curvaria entre pontos e sugeriria valores que não existiram), pontos vazados. A linha INTERROMPE
//   onde não há dado (`stepMs`, decisão 59): nunca liga dois pontos separados por intervalos vazios. Ponto sem vizinho aparece como
//   ponto isolado, mesmo com muitos pontos no período.
//   Colunas: largura que cabe sem encostar na vizinha (entre 3 e 18 px); com várias séries ficam lado a lado.
//   Cores: só as que o chamador passa em `series[].color` (tokens do tema); sem cor, a série principal da marca.
// Eixo X em ESCALA DE TEMPO: pontos separados pela distância real, não equidistantes.

export interface TimeSeries {
  key: string;
  label: string;
  /** Token do tema (ex.: `hsl(var(--danger))`); padrão: a série principal da marca. */
  color?: string;
  /** Série de apoio (ex.: período anterior): linha tracejada e sem bolinhas. */
  dashed?: boolean;
  /** Só aparece em Linha: em Colunas seria uma segunda barra sem leitura (ex.: período anterior). */
  lineOnly?: boolean;
}

export interface TimePoint {
  /** Instante (ms desde 1970) que posiciona o ponto no eixo de tempo. */
  t: number;
  [key: string]: number | null | undefined;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function TimeSeriesChart({
  data,
  series,
  title,
  height = 280,
  formatTick,
  formatLabel,
  formatValue,
  formatAxis,
  ticks,
  yWidth = 72,
  singlePointPadMs = ONE_DAY_MS,
  stepMs,
  initialMode = DEFAULT_TIME_CHART_MODE,
  footnote,
  details,
}: {
  data: TimePoint[];
  series: TimeSeries[];
  title: string;
  height?: number;
  formatTick: (t: number) => string;
  formatLabel: (t: number) => string;
  formatValue: (value: number, key: string) => string;
  formatAxis: (value: number) => string;
  /** Rótulos explícitos do eixo X (ex.: um por dia com venda); sem isso a biblioteca escolhe espaçamentos legíveis. */
  ticks?: number[];
  yWidth?: number;
  singlePointPadMs?: number;
  /** Intervalo do agrupamento da série em ms (dia, hora...). Com ele, intervalos sem dado interrompem a linha. */
  stepMs?: number;
  initialMode?: TimeChartMode;
  /** Aviso sob o gráfico; sem aviso, um único ponto no período ganha o aviso padrão. */
  footnote?: ReactNode;
  /** Linhas extras da dica para o ponto sob o cursor (ex.: detalhe por forma de pagamento). Recebe a linha de dados do ponto. */
  details?: (row: TimePoint) => ReactNode;
}) {
  const [mode, setMode] = useState<TimeChartMode>(initialMode);
  const [width, setWidth] = useState(640);
  const [flip, setFlip] = useState(false);
  const columns = mode === 'columns';
  series = columns ? series.filter((s) => !s.lineOnly) : series; // séries `lineOnly` (ex.: período anterior) só existem na Linha
  const plotted = useMemo(() => breakAtGaps(data, stepMs), [data, stepMs]);
  const n = data.length;
  const dense = n > 31; // muitos pontos: bolinhas viram ruído (exceto o ponto isolado, que é o único sinal do dado)
  const multi = series.length > 1;
  const plotWidth = Math.max(120, width - yWidth - 20 - (columns ? 56 : 32));
  // Largura da coluna: a que cabe SEM encostar na vizinha. O limite é a menor distância (em pixels) entre dois pontos consecutivos no eixo
  // de tempo; nunca passa de 18 px (10 com várias séries, lado a lado) e nunca fica abaixo de 3 px (ainda visível).
  const times = data.map((d) => d.t).sort((x, y) => x - y);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) minGap = Math.min(minGap, times[i] - times[i - 1]);
  const gapPx = span > 0 && Number.isFinite(minGap) ? (plotWidth * minGap) / span : Number.POSITIVE_INFINITY;
  const barSize = Math.round(Math.max(3, Math.min(multi ? 10 : 18, (gapPx * 0.8) / series.length)));
  const single = n === 1 ? data[0].t : null;

  // Bolinha do ponto: sempre com poucos pontos; com muitos, só quando o ponto não tem vizinho (não há linha para mostrá-lo).
  const renderDot = (key: string, color: string, support = false) =>
    function Dot(p: { cx?: number; cy?: number; index?: number; value?: unknown; key?: string }) {
      const i = Number(p.index);
      const hole = <g key={p.key ?? `${key}-${i}`} />;
      if (p.value === null || p.value === undefined || !Number.isFinite(p.cx) || !Number.isFinite(p.cy)) return hole;
      const alone = isEmptyPoint(plotted[i - 1], [key]) && isEmptyPoint(plotted[i + 1], [key]);
      if ((dense || support) && !alone) return hole; // série de apoio (tracejada): sem bolinhas, só o ponto sem vizinho
      return <circle key={p.key ?? `${key}-${i}`} cx={p.cx} cy={p.cy} r={3} fill={CHART_SURFACE} stroke={color} strokeWidth={2} />;
    };

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <ChartModeToggle value={mode} onChange={setMode} options={TIME_CHART_MODES} ariaLabel={`Tipo de gráfico de ${title.toLowerCase()}`} />
      </div>
      <div role="img" aria-label={`${title}: ${n} ponto(s), em ${columns ? 'colunas' : 'linha'}`}>
        <ResponsiveContainer width="100%" height={height} onResize={(w) => setWidth(w)}>
          <ComposedChart
            data={plotted}
            margin={{ top: 12, right: 16, left: 4, bottom: 4 }}
            // A dica abre do lado com mais espaço (metade direita do gráfico → à esquerda do cursor), longe das colunas vizinhas.
            onMouseMove={(s: { activeCoordinate?: { x?: number } }) => setFlip((s?.activeCoordinate?.x ?? 0) > (yWidth + width) / 2)}
          >
            <CartesianGrid vertical={false} stroke={CHART_GRID} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={single !== null ? [single - singlePointPadMs, single + singlePointPadMs] : ['dataMin', 'dataMax']}
              ticks={ticks}
              tickFormatter={(t) => formatTick(Number(t))}
              tick={{ fill: CHART_AXIS, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: CHART_GRID }}
              padding={{ left: columns ? 28 : 16, right: columns ? 28 : 16 }}
              minTickGap={24}
            />
            <YAxis
              width={yWidth}
              tickFormatter={(v) => formatAxis(Number(v))}
              tick={{ fill: CHART_AXIS, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              // Na linha, o zero sobe alguns pixels acima do eixo X: série em zero (ex.: erros 5xx) não se confunde com o eixo. Só
              // desloca o desenho; o valor continua zero e a escala não ganha nenhum número a mais.
              padding={columns ? undefined : { top: 0, bottom: 10 }}
            />
            <Tooltip
              isAnimationActive={false}
              offset={14}
              reverseDirection={{ x: flip, y: false }}
              cursor={columns ? { fill: CHART_CURSOR, fillOpacity: 0.6 } : { stroke: CHART_GRID }}
              content={<ChartTooltip formatLabel={(t) => formatLabel(Number(t))} formatValue={formatValue} seriesLabel={multi ? undefined : series[0]?.label} details={details} />}
            />
            {series.map((s) => {
              const color = s.color ?? CHART_PRIMARY;
              return columns ? (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={color} radius={[3, 3, 0, 0]} barSize={barSize} isAnimationActive={false} />
              ) : (
                <Line
                  key={s.key}
                  type="linear"
                  dataKey={s.key}
                  name={s.label}
                  stroke={color}
                  strokeWidth={s.dashed ? 1.5 : 2}
                  strokeDasharray={s.dashed ? '5 4' : undefined}
                  connectNulls={false}
                  dot={renderDot(s.key, color, Boolean(s.dashed))}
                  activeDot={{ r: 5, fill: color, stroke: CHART_SURFACE, strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {multi && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-2">
              <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: s.color ?? CHART_PRIMARY }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {footnote ??
        (n === 1 ? <p className="mt-2 text-xs text-muted-foreground">Só há um ponto de dado no período; uma evolução precisa de pelo menos dois.</p> : null)}
    </div>
  );
}
