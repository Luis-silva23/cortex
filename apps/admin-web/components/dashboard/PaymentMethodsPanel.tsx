'use client';

import { Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count, money, percentText, type Comparison, type ManagementSummary } from '@/lib/dashboard-management';

// Formas de pagamento oficiais do CÓRTEX (Cartão, PIX, Dinheiro, Convênio funcionário e empresa; "Outras formas" só quando há uso).
// Vendas = vendas DISTINTAS que usaram a forma; ticket = valor pago na forma ÷ essas vendas; participação = parte do valor pago. Cartão
// pode ser detalhado em débito e crédito (sem bandeira nem parcelas: a origem atual não as registra de forma confiável).

const TONE: Record<Comparison['outcome'], string> = { better: 'text-success', worse: 'text-danger', neutral: 'text-muted-foreground' };

export function PaymentMethodsPanel({ summary, loading, error, compare, onRetry }: { summary: ManagementSummary | null; loading: boolean; error: string | null; compare: boolean; onRetry: () => void }) {
  const groups = summary?.paymentMethods.groups ?? [];
  const totalPaid = summary?.paymentMethods.totalAmount.current ?? 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-lg">
          Formas de pagamento
          {summary && (
            <span title={summary.definitions.paymentMethods} className="cursor-help text-muted-foreground" tabIndex={0} role="img" aria-label={`Como é calculado: ${summary.definitions.paymentMethods}`}>
              <Info className="h-4 w-4" aria-hidden />
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-sm text-danger">{error}</p>
            <button type="button" onClick={onRetry} className="text-sm underline underline-offset-2">
              Tentar novamente
            </button>
          </div>
        ) : totalPaid === 0 && groups.every((g) => g.current.sales === 0) ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nenhum pagamento aprovado no período.</p>
        ) : (
          <ul className="space-y-3">
            {groups.map((g) => (
              <li key={g.key} className="rounded-md border border-border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">{g.label}</p>
                  <p className="text-sm font-semibold text-foreground">{money(g.current.amount)}</p>
                </div>
                <p className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
                  <span>
                    {count(g.current.sales)} {g.current.sales === 1 ? 'venda' : 'vendas'} · ticket médio {money(g.current.avgTicket)}
                  </span>
                  <span>{g.current.share === null ? '—' : percentText(g.current.share)} do pago</span>
                </p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, g.current.share ?? 0)}%` }} />
                </div>
                {g.details && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {g.details.map((d) => `${d.label}: ${count(d.sales)} ${d.sales === 1 ? 'venda' : 'vendas'} · ${money(d.amount)}`).join('  |  ')}
                  </p>
                )}
                {compare && (
                  <p className={`mt-1 text-xs ${g.amount.percent === null ? 'text-muted-foreground' : TONE[g.amount.outcome]}`}>
                    {g.amount.percent === null ? `Anterior: ${money(g.previous.amount)} · sem base de comparação` : `${percentText(g.amount.percent, true)} · anterior ${money(g.previous.amount)}`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
