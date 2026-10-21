import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, type QuoteTotals as Totals } from '@/lib/quotes';

// Valores numéricos neutros (sem cor semântica). O desconto é exibido como
// vem do orçamento (hoje sempre R$ 0,00: o backend não tem regra nem
// autorização de desconto para orçamentos).
export function QuoteTotals({ totals, title = 'Valores' }: { totals: Totals; title?: string }) {
  const rows: Array<{ label: string; value: number; testId: string }> = [
    { label: 'Mão de obra', value: totals.laborTotal, testId: 'labor' },
    { label: 'Peças', value: totals.partsTotal, testId: 'parts' },
    { label: 'Desconto', value: totals.discountAmount, testId: 'discount' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="font-medium tabular-nums text-foreground" data-testid={`totals-${row.testId}`}>
                {row.testId === 'discount' && row.value > 0 ? '− ' : ''}
                {formatCurrency(row.value)}
              </dd>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <dt className="text-base font-semibold text-foreground">Total</dt>
            <dd className="text-xl font-bold tabular-nums text-foreground" data-testid="totals-total">
              {formatCurrency(totals.totalAmount)}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
