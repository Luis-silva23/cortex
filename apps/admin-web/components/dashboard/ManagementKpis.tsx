'use client';

import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Banknote, Info, Minus, Percent, Receipt, ShoppingCart, Undo2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { count, money, percentText, signedCount, signedMoney, type Comparison, type ManagementSummary } from '@/lib/dashboard-management';

// Seis KPIs do painel gerencial. Cada um mostra o valor do período, e (com "Comparar" ligado) o anterior, a diferença absoluta, a
// variação percentual e se melhorou ou piorou. O sentido de "melhor" vem da API (`outcome`), que conhece a regra de cada indicador
// (ex.: mais cancelamentos = pior; saques não são julgados). Anterior zero não gera percentual: aparece "sem base de comparação".

const TONE: Record<Comparison['outcome'], string> = { better: 'text-success', worse: 'text-danger', neutral: 'text-muted-foreground' };
const OUTCOME_TEXT: Record<Comparison['outcome'], string> = { better: 'melhora', worse: 'piora', neutral: 'sem julgamento' };

function Delta({ cmp, previousLabel, format, signed }: { cmp: Comparison; previousLabel: string; format: (v: number | null) => string; signed: (v: number | null) => string }) {
  if (cmp.previous === null || cmp.current === null) {
    return <p className="mt-1 text-xs text-muted-foreground">Sem base de comparação ({previousLabel})</p>;
  }
  const Arrow = cmp.trend === 'up' ? ArrowUpRight : cmp.trend === 'down' ? ArrowDownRight : Minus;
  return (
    <div className="mt-1 space-y-0.5 text-xs">
      <p className={`flex flex-wrap items-center gap-x-1 font-medium ${cmp.percent === null ? 'text-muted-foreground' : TONE[cmp.outcome]}`} aria-label={`${signed(cmp.diff)}, ${cmp.percent === null ? 'sem percentual (anterior zero)' : percentText(cmp.percent, true)}, ${OUTCOME_TEXT[cmp.outcome]}`}>
        <Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{signed(cmp.diff)}</span>
        <span>{cmp.percent === null ? '· sem base' : `(${percentText(cmp.percent, true)})`}</span>
      </p>
      <p className="text-muted-foreground" title={`Período anterior: ${previousLabel}`}>
        Anterior: {format(cmp.previous)}
      </p>
    </div>
  );
}

function Kpi({
  title,
  icon: Icon,
  definition,
  value,
  sub,
  loading,
  delta,
}: {
  title: string;
  icon: typeof Banknote;
  definition: string;
  value: string;
  sub?: ReactNode;
  loading: boolean;
  delta?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <span className="inline-flex items-center gap-1.5">
            <span title={definition} className="cursor-help text-muted-foreground" tabIndex={0} role="img" aria-label={`Como é calculado: ${definition}`}>
              <Info className="h-3.5 w-3.5" aria-hidden />
            </span>
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          </span>
        </div>
        {loading ? (
          <div className="mt-2 space-y-2" aria-hidden>
            <div className="h-7 w-28 animate-pulse rounded bg-muted" />
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <>
            <p className="mt-1 text-xl font-bold text-foreground sm:text-2xl">{value}</p>
            {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
            {delta}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ManagementKpis({ summary, loading, compare }: { summary: ManagementSummary | null; loading: boolean; compare: boolean }) {
  const k = summary?.kpis;
  const d = summary?.definitions;
  const prev = summary?.period.previous.label ?? 'período anterior';
  const wait = loading || !k || !d;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Indicadores do período">
      <Kpi
        title="Receita"
        icon={Banknote}
        definition={d?.revenue ?? ''}
        loading={wait}
        value={money(k?.revenue.current)}
        delta={compare && k ? <Delta cmp={k.revenue} previousLabel={prev} format={money} signed={signedMoney} /> : undefined}
      />
      <Kpi
        title="Vendas"
        icon={ShoppingCart}
        definition={d?.sales ?? ''}
        loading={wait}
        value={count(k?.sales.current)}
        delta={compare && k ? <Delta cmp={k.sales} previousLabel={prev} format={count} signed={signedCount} /> : undefined}
      />
      <Kpi
        title="Ticket médio"
        icon={Receipt}
        definition={d?.avgTicket ?? ''}
        loading={wait}
        value={money(k?.avgTicket.current)}
        sub={k && k.avgTicket.current === null ? 'Sem vendas no período' : undefined}
        delta={compare && k ? <Delta cmp={k.avgTicket} previousLabel={prev} format={money} signed={signedMoney} /> : undefined}
      />
      <Kpi
        title="Saques"
        icon={Banknote}
        definition={d?.withdrawals ?? ''}
        loading={wait}
        value={money(k?.withdrawals.amount.current)}
        sub={k ? `${count(k.withdrawals.count.current)} ${k.withdrawals.count.current === 1 ? 'retirada' : 'retiradas'}` : undefined}
        delta={compare && k ? <Delta cmp={k.withdrawals.amount} previousLabel={prev} format={money} signed={signedMoney} /> : undefined}
      />
      <Kpi
        title="Cancelamentos e devoluções"
        icon={Undo2}
        definition={d?.cancellations ?? ''}
        loading={wait}
        value={count(k?.cancellations.total.current)}
        sub={k ? `${count(k.cancellations.cancelled.current)} cancel. · ${count(k.cancellations.returned.current)} devol.` : undefined}
        delta={compare && k ? <Delta cmp={k.cancellations.total} previousLabel={prev} format={count} signed={signedCount} /> : undefined}
      />
      <Kpi
        title="Descontos"
        icon={Percent}
        definition={d?.discounts ?? ''}
        loading={wait}
        value={money(k?.discounts.amount.current)}
        sub={k ? `${k.discounts.percentOfGross.current === null ? '—' : percentText(k.discounts.percentOfGross.current)} do valor bruto · ${count(k.discounts.salesWithDiscount.current)} vendas` : undefined}
        delta={compare && k ? <Delta cmp={k.discounts.amount} previousLabel={prev} format={money} signed={signedMoney} /> : undefined}
      />
    </div>
  );
}
