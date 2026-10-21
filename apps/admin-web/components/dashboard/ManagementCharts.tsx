'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TimeSeriesChart, type TimePoint } from '@/components/charts/TimeSeriesChart';
import { DonutChart, donutColor } from '@/components/charts/DonutChart';
import { CHART_AXIS } from '@/lib/chart-theme';
import { formatBRLCompact } from '@/lib/chart-format';
import { count, money, percentText, timeFormatters, type ManagementSummary, type ManagementTimeseries, type SeriesPoint } from '@/lib/dashboard-management';

// Gráficos do painel gerencial. Linha é o padrão e Colunas a alternativa (controle do próprio TimeSeriesChart, estado local: sem nova
// chamada). A troca de métrica (Receita | Vendas | Ticket médio) também é só estado local sobre os MESMOS dados que a API já devolveu.
// Venda sem movimento em um dia/hora/mês do período é ZERO; ticket sem venda é indefinido (a linha interrompe, não vira zero).

const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

function Section({ title, hint, children, aside }: { title: string; hint?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-lg">
          <span className="flex items-center gap-2">
            {title}
            {hint && (
              <span title={hint} className="cursor-help text-muted-foreground" tabIndex={0} role="img" aria-label={`Como é calculado: ${hint}`}>
                <Info className="h-4 w-4" aria-hidden />
              </span>
            )}
          </span>
          {aside}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function State({ loading, error, onRetry, empty, rows = 5, children }: { loading: boolean; error: string | null; onRetry: () => void; empty?: string | null; rows?: number; children: ReactNode }) {
  if (loading)
    return (
      <div className="space-y-3" aria-hidden>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 w-full animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  if (error)
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-sm text-danger">{error}</p>
        <button type="button" onClick={onRetry} className="text-sm underline underline-offset-2">
          Tentar novamente
        </button>
      </div>
    );
  if (empty) return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>;
  return <>{children}</>;
}

// ---------- evolução (receita | vendas | ticket médio) ----------

type Metric = 'revenue' | 'sales' | 'avgTicket';
const METRICS: Array<{ value: Metric; label: string }> = [
  { value: 'revenue', label: 'Receita' },
  { value: 'sales', label: 'Vendas' },
  { value: 'avgTicket', label: 'Ticket médio' },
];
const metricOf = (p: { revenue: number; sales: number; avgTicket: number | null }, m: Metric): number | null => (m === 'revenue' ? p.revenue : m === 'sales' ? p.sales : p.avgTicket);

export function EvolutionCard({ series, loading, error, compare, onRetry }: { series: ManagementTimeseries | null; loading: boolean; error: string | null; compare: boolean; onRetry: () => void }) {
  const [metric, setMetric] = useState<Metric>('revenue');
  const f = useMemo(() => timeFormatters(series?.granularity ?? 'day'), [series?.granularity]);
  const label = METRICS.find((m) => m.value === metric)!.label;
  const isMoney = metric !== 'sales';

  const { rows, byT } = useMemo(() => {
    const byT = new Map<number, { point: SeriesPoint; prev?: ManagementTimeseries['previousPoints'][number] }>();
    const rows: TimePoint[] = (series?.points ?? []).map((p, i) => {
      const t = Date.parse(p.t);
      const prev = series?.previousPoints[i];
      byT.set(t, { point: p, prev });
      return { t, value: metricOf(p, metric), prev: prev ? metricOf(prev, metric) : null };
    });
    return { rows, byT };
  }, [series, metric]);

  const details = (row: TimePoint) => {
    const e = byT.get(Number(row.t));
    if (!e || !series) return null;
    const p = e.point;
    const used = series.methods.filter((m) => p.byMethod[m.key]);
    return (
      <div className="mt-2 space-y-0.5 border-t border-border pt-2">
        {used.map((m) => (
          <p key={m.key} className="flex justify-between gap-3 text-muted-foreground">
            <span>{m.label}</span>
            <span className="text-foreground">
              {plural(p.byMethod[m.key].sales, 'venda', 'vendas')} · {money(p.byMethod[m.key].amount)}
            </span>
          </p>
        ))}
        <p className="flex justify-between gap-3 font-medium text-foreground">
          <span>Total</span>
          <span>
            {plural(p.sales, 'venda', 'vendas')} · {money(p.revenue)}
          </span>
        </p>
        {compare && e.prev && (
          <p className="pt-1 text-muted-foreground">
            Anterior ({f.label(Date.parse(e.prev.t))}): {plural(e.prev.sales, 'venda', 'vendas')} · {money(e.prev.revenue)}
          </p>
        )}
      </div>
    );
  };

  const empty = series && series.points.every((p) => p.sales === 0) ? 'Nenhuma venda realizada no período selecionado.' : null;

  return (
    <Section
      title="Evolução"
      hint="Os mesmos dados do período, em receita, quantidade de vendas ou ticket médio (receita ÷ vendas distintas). Dia sem venda é zero; ticket sem venda não existe."
      aside={
        <div role="group" aria-label="Métrica da evolução" className="inline-flex rounded-md border border-border p-0.5 text-sm font-normal">
          {METRICS.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={metric === m.value}
              onClick={() => setMetric(m.value)}
              className={`rounded px-2.5 py-1 transition-colors ${metric === m.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      }
    >
      <State loading={loading} error={error} onRetry={onRetry} empty={empty}>
        {series && (
          <TimeSeriesChart
            data={rows}
            series={[
              { key: 'value', label },
              ...(compare ? [{ key: 'prev', label: `${label} (${series.period.previous.label})`, color: CHART_AXIS, dashed: true, lineOnly: true }] : []),
            ]}
            title={`Evolução de ${label.toLowerCase()}`}
            height={300}
            formatTick={f.tick}
            formatLabel={f.label}
            formatValue={(v) => (isMoney ? money(v) : count(v))}
            formatAxis={(v) => (isMoney ? formatBRLCompact(v) : count(v))}
            singlePointPadMs={f.pad}
            details={details}
          />
        )}
      </State>
    </Section>
  );
}

// ---------- origem das vendas ----------

export function OriginPanel({ summary, series, loading, error, onRetry }: { summary: ManagementSummary | null; series: ManagementTimeseries | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const o = summary?.origins;
  const f = useMemo(() => timeFormatters(series?.granularity ?? 'day'), [series?.granularity]);
  const channels = series?.channels ?? [];

  const rows: TimePoint[] = useMemo(
    () => (series?.points ?? []).map((p) => ({ t: Date.parse(p.t), ...Object.fromEntries(channels.map((c) => [`c_${c.key}`, p.byChannel[c.key]?.revenue ?? 0])) })),
    [series, channels]
  );
  const byT = useMemo(() => new Map((series?.points ?? []).map((p) => [Date.parse(p.t), p])), [series]);
  const details = (row: TimePoint) => {
    const p = byT.get(Number(row.t));
    if (!p) return null;
    return (
      <div className="mt-2 space-y-0.5 border-t border-border pt-2">
        {channels.map((c) => (
          <p key={c.key} className="flex justify-between gap-3 text-muted-foreground">
            <span>{c.name}</span>
            <span className="text-foreground">{plural(p.byChannel[c.key]?.sales ?? 0, 'venda', 'vendas')}</span>
          </p>
        ))}
        <p className="flex justify-between gap-3 font-medium text-foreground">
          <span>Total do dia</span>
          <span>
            {plural(Object.values(p.byChannel).reduce((a, c) => a + c.sales, 0), 'venda', 'vendas')} · {money(Object.values(p.byChannel).reduce((a, c) => a + c.revenue, 0))}
          </span>
        </p>
      </div>
    );
  };

  const empty = o && o.totalRevenue === 0 && o.excluded.revenue === 0 ? 'Nenhuma venda realizada no período selecionado.' : null;

  return (
    <Section title="Origem das vendas" hint={summary?.definitions.origins}>
      <State loading={loading} error={error} onRetry={onRetry} empty={empty} rows={6}>
        {o && (
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
              Receita no período: <span className="font-semibold text-foreground">{money(summary!.kpis.revenue.current)}</span>
            </p>
            <div className="grid items-center gap-6 md:grid-cols-[220px_1fr]">
              <DonutChart
                slices={o.items.map((i) => ({ key: i.key, name: i.name, value: i.revenue }))}
                total={o.totalRevenue}
                centerLabel="Na composição"
                centerValue={money(o.totalRevenue)}
                formatValue={money}
                ariaLabel={`Receita por origem: ${o.items.map((i) => `${i.name} ${money(i.revenue)}`).join(', ')}`}
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Origem</th>
                      <th className="px-3 py-2 text-right font-medium">Receita</th>
                      <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Vendas</th>
                      <th className="py-2 pl-3 text-right font-medium">Participação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.items.map((i, idx) => (
                      <tr key={i.key} className="border-b border-border/60">
                        <td className="py-2 pr-3">
                          <span className="inline-flex items-center gap-2 text-foreground">
                            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: donutColor(idx) }} />
                            {i.name}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-foreground">{money(i.revenue)}</td>
                        <td className="hidden px-3 py-2 text-right text-muted-foreground sm:table-cell">{count(i.sales)}</td>
                        <td className="py-2 pl-3 text-right text-muted-foreground">{i.share === null ? '—' : percentText(i.share)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="pt-2 pr-3 text-xs text-muted-foreground">Total</td>
                      <td className="px-3 pt-2 text-right text-sm font-semibold text-foreground">{money(o.totalRevenue)}</td>
                      <td className="hidden px-3 pt-2 text-right text-xs text-muted-foreground sm:table-cell">{count(o.totalSales)}</td>
                      <td className="pl-3 pt-2 text-right text-xs text-muted-foreground">100%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            {o.excluded.sales > 0 && (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                {money(o.excluded.revenue)} ({plural(o.excluded.sales, 'venda', 'vendas')}) de canais desativados não entram na composição, mas continuam na receita acima.
              </p>
            )}
            {channels.length > 1 && series && (
              <div>
                <p className="mb-2 text-sm font-medium text-foreground">Evolução da receita por origem</p>
                <TimeSeriesChart
                  data={rows}
                  series={channels.map((c) => ({ key: `c_${c.key}`, label: c.name, color: donutColor(channels.indexOf(c)) }))}
                  title="Evolução da receita por origem"
                  height={260}
                  formatTick={f.tick}
                  formatLabel={f.label}
                  formatValue={(v) => money(v)}
                  formatAxis={(v) => formatBRLCompact(v)}
                  singlePointPadMs={f.pad}
                  details={details}
                />
              </div>
            )}
          </div>
        )}
      </State>
    </Section>
  );
}

// ---------- caixa e saques ----------

export function CashPanel({ summary, series, loading, error, onRetry }: { summary: ManagementSummary | null; series: ManagementTimeseries | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const f = useMemo(() => timeFormatters(series?.granularity ?? 'day'), [series?.granularity]);
  const rows: TimePoint[] = useMemo(() => (series?.points ?? []).map((p) => ({ t: Date.parse(p.t), amount: p.withdrawals.amount })), [series]);
  const byT = useMemo(() => new Map((series?.points ?? []).map((p) => [Date.parse(p.t), p])), [series]);
  const details = (row: TimePoint) => {
    const p = byT.get(Number(row.t));
    return p ? <p className="mt-2 border-t border-border pt-2 text-muted-foreground">{plural(p.withdrawals.count, 'retirada', 'retiradas')}</p> : null;
  };
  const c = summary?.cash;
  const none = series && series.points.every((p) => p.withdrawals.count === 0);
  return (
    <Section title="Caixa e saques" hint={summary?.definitions.withdrawals}>
      <State loading={loading} error={error} onRetry={onRetry} rows={4}>
        {c && (
          <div className="space-y-4">
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Caixas abertos agora</dt>
                <dd className="font-semibold text-foreground">{count(c.openRegisters)}</dd>
                <dd className="text-xs text-muted-foreground">esperado {money(c.openExpectedAmount)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Fechamentos com diferença</dt>
                <dd className={`font-semibold ${c.divergentClosings > 0 ? 'text-danger' : 'text-foreground'}`}>
                  {count(c.divergentClosings)} <span className="text-xs font-normal text-muted-foreground">de {count(c.closings)}</span>
                </dd>
                <dd className="text-xs text-muted-foreground">soma {money(c.differenceSum)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Fechamentos forçados</dt>
                <dd className={`font-semibold ${c.forcedClosings > 0 ? 'text-warning' : 'text-foreground'}`}>{count(c.forcedClosings)}</dd>
              </div>
            </dl>
            {none ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Nenhum saque no período.</p>
            ) : (
              series && (
                <TimeSeriesChart
                  data={rows}
                  series={[{ key: 'amount', label: 'Saques' }]}
                  title="Saques no período"
                  height={180}
                  yWidth={64}
                  formatTick={f.tick}
                  formatLabel={f.label}
                  formatValue={(v) => money(v)}
                  formatAxis={(v) => formatBRLCompact(v)}
                  singlePointPadMs={f.pad}
                  details={details}
                />
              )
            )}
          </div>
        )}
      </State>
    </Section>
  );
}
