'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertCircle, ArrowLeft, Printer, RefreshCw, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CancelSaleDialog } from '@/components/sales/CancelSaleDialog';
import { api, getCurrentUserClaims } from '@/lib/api';
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  PAYMENT_STATUS_VARIANT,
  SALE_STATUS_LABEL,
  SALE_STATUS_VARIANT,
  canCancelSale,
} from '@/lib/sales';
import { formatCurrency, formatDateTime } from '@/lib/utils';

function qty(value: number | string): string {
  return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

export default function SaleDetailPage() {
  const params = useParams<{ id: string }>();
  const saleId = params?.id;

  const [sale, setSale] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'not-found' | 'generic' | null>(null);
  const [userType, setUserType] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    setUserType(getCurrentUserClaims()?.userType ?? null);
  }, []);

  const loadSale = useCallback(async () => {
    if (!saleId) return;
    setLoadError(null);
    try {
      setSale(await api.getSale(saleId));
    } catch (error: any) {
      console.error('Erro ao carregar venda:', error);
      setLoadError(error?.response?.status === 404 ? 'not-found' : 'generic');
    } finally {
      setLoading(false);
    }
  }, [saleId]);

  useEffect(() => {
    loadSale();
  }, [loadSale]);

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="Carregando venda">
        <div className="h-9 w-64 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (loadError || !sale) {
    return (
      <Card>
        <CardContent className="p-12 text-center" data-testid="sale-load-error">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" aria-hidden />
          <h2 className="mb-2 text-lg font-medium text-foreground">
            {loadError === 'not-found' ? 'Venda não encontrada' : 'Não foi possível carregar a venda'}
          </h2>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/dashboard/sales">
              <Button variant="outline">Voltar para vendas</Button>
            </Link>
            {loadError !== 'not-found' && (
              <Button
                onClick={() => {
                  setLoading(true);
                  loadSale();
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
                Tentar novamente
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const status: string = sale.status;
  const hadApprovedPayment = (sale.payments ?? []).some((p: any) => p.status === 'APPROVED');
  const partnerDiscount = Number(sale.partnerDiscountAmount ?? 0);
  const change = Number(sale.changeAmount ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <Link href="/dashboard/sales" aria-label="Voltar para vendas">
            <Button variant="ghost" size="icon" type="button">
              <ArrowLeft className="h-5 w-5" aria-hidden />
            </Button>
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold text-foreground" data-testid="sale-title">
                Venda #{String(sale.saleNumber).padStart(6, '0')}
              </h1>
              <Badge variant={SALE_STATUS_VARIANT[status] ?? 'secondary'} data-status={status}>
                {SALE_STATUS_LABEL[status] ?? status}
              </Badge>
            </div>
            <p className="mt-1 text-muted-foreground">{formatDateTime(sale.saleDate ?? sale.createdAt)}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="mr-2 h-4 w-4" aria-hidden />
            Imprimir
          </Button>
          {canCancelSale(sale, userType) && (
            <Button variant="outline" onClick={() => setCancelOpen(true)} data-testid="action-cancel-sale">
              <XCircle className="mr-2 h-4 w-4 text-danger" aria-hidden />
              Cancelar venda
            </Button>
          )}
        </div>
      </div>

      {status === 'CANCELLED' && (
        <Alert variant="destructive" data-testid="cancelled-notice">
          <AlertTitle>Venda cancelada</AlertTitle>
          <AlertDescription>
            {sale.cancelReason ? `Motivo: ${sale.cancelReason}` : 'Sem motivo registrado.'}
            {sale.cancelledAt ? ` · em ${formatDateTime(sale.cancelledAt)}` : ''}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="min-w-0 space-y-6 md:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Produtos</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-center">Qtd</TableHead>
                    <TableHead className="text-right">Preço unit.</TableHead>
                    <TableHead className="text-right">Desconto</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(sale.items ?? []).map((item: any) => (
                    <TableRow key={item.id} data-testid="sale-item-row">
                      <TableCell>
                        <p className="font-medium">{item.productName ?? item.product?.name}</p>
                        <p className="text-sm text-muted-foreground">{item.productSku ?? item.product?.sku}</p>
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {qty(item.quantity)}
                        {Number(item.returnedQuantity) > 0 && (
                          <span className="block text-xs text-muted-foreground">devolvido: {qty(item.returnedQuantity)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(Number(item.unitPrice))}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Number(item.discountAmount) > 0 ? formatCurrency(Number(item.discountAmount)) : '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatCurrency(Number(item.totalPrice))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <dl className="mt-6 space-y-2 border-t border-border pt-4 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Subtotal</dt>
                  <dd className="tabular-nums" data-testid="sale-subtotal">{formatCurrency(Number(sale.subtotal))}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Desconto</dt>
                  <dd className="tabular-nums" data-testid="sale-discount">
                    {Number(sale.discountAmount) > 0 ? `− ${formatCurrency(Number(sale.discountAmount))}` : formatCurrency(0)}
                  </dd>
                </div>
                {partnerDiscount > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Desconto parceiro</dt>
                    <dd className="tabular-nums">− {formatCurrency(partnerDiscount)}</dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-border pt-2 text-lg font-bold">
                  <dt>Total</dt>
                  <dd className="tabular-nums" data-testid="sale-total">{formatCurrency(Number(sale.totalAmount))}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Pago</dt>
                  <dd className="tabular-nums">{formatCurrency(Number(sale.paidAmount))}</dd>
                </div>
                {change > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Troco</dt>
                    <dd className="tabular-nums">{formatCurrency(change)}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pagamentos</CardTitle>
            </CardHeader>
            <CardContent>
              {(sale.payments ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum pagamento registrado.</p>
              ) : (
                <ul className="space-y-3">
                  {sale.payments.map((payment: any) => (
                    <li
                      key={payment.id}
                      data-testid="sale-payment-row"
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{PAYMENT_METHOD_LABEL[payment.paymentMethod] ?? payment.paymentMethod}</p>
                          <Badge variant={PAYMENT_STATUS_VARIANT[payment.status] ?? 'secondary'}>
                            {PAYMENT_STATUS_LABEL[payment.status] ?? payment.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {formatDateTime(payment.paidAt ?? payment.createdAt)}
                          {payment.installments > 1 ? ` · ${payment.installments}x` : ''}
                          {payment.cardBrand ? ` · ${payment.cardBrand}${payment.cardLastDigits ? ` •••• ${payment.cardLastDigits}` : ''}` : ''}
                        </p>
                      </div>
                      <p className="text-lg font-bold tabular-nums">{formatCurrency(Number(payment.amount))}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Cliente</CardTitle>
            </CardHeader>
            <CardContent>
              {sale.customer ? (
                <div>
                  <p className="font-medium">{sale.customer.name}</p>
                  {(sale.customer.phone || sale.customer.mobile) && (
                    <p className="mt-1 text-sm text-muted-foreground">{sale.customer.phone || sale.customer.mobile}</p>
                  )}
                  {sale.customer.email && <p className="text-sm text-muted-foreground">{sale.customer.email}</p>}
                </div>
              ) : (
                <p className="text-muted-foreground">Sem cliente vinculado</p>
              )}
            </CardContent>
          </Card>

          {sale.user?.name && (
            <Card>
              <CardHeader>
                <CardTitle>Vendedor</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="font-medium" data-testid="sale-seller">{sale.user.name}</p>
              </CardContent>
            </Card>
          )}

          {sale.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Observações</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{sale.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <CancelSaleDialog
        open={cancelOpen}
        sale={{ id: sale.id, saleNumber: sale.saleNumber, totalAmount: sale.totalAmount }}
        hadApprovedPayment={hadApprovedPayment}
        onOpenChange={setCancelOpen}
        onCancelled={() => {
          loadSale();
        }}
      />
    </div>
  );
}
