'use client';

import { useEffect, useState, useCallback } from 'react';
import { formatCurrency } from '@/lib/utils';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, PackageCheck, XCircle, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';

interface POItem {
  id: string;
  quantity: number;
  receivedQuantity: number;
  unitCost: number;
  totalCost: number;
  product: { id: string; name: string; sku: string };
}

interface PurchaseOrder {
  id: string;
  poNumber: number;
  status: 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED' | 'CANCELLED';
  branchId: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  notes?: string | null;
  expectedDelivery?: string | null;
  orderDate: string;
  receivedDate?: string | null;
  supplier: { id: string; name: string; document: string };
  items: POItem[];
  invoices?: any[];
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Rascunho',
  SENT: 'Enviado',
  CONFIRMED: 'Confirmado',
  RECEIVED: 'Recebido',
  CANCELLED: 'Cancelado',
};

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'error'> = {
  DRAFT: 'secondary',
  SENT: 'warning',
  CONFIRMED: 'default',
  RECEIVED: 'success',
  CANCELLED: 'error',
};

export default function PurchaseOrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  const [invoiceEnabled, setInvoiceEnabled] = useState(false);
  const [invoice, setInvoice] = useState({
    invoiceNumber: '',
    series: '',
    accessKey: '',
    issueDate: '',
    totalAmount: '',
  });
  const [receiving, setReceiving] = useState(false);
  const [receiveError, setReceiveError] = useState<string | null>(null);

  const loadOrder = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getPurchaseOrder(id);
      setOrder(result);
    } catch (err) {
      console.error('Erro ao carregar pedido de compra:', err);
      setError('Não foi possível carregar o pedido de compra.');
      setOrder(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  const handleApprove = async () => {
    if (!order) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await api.approvePurchaseOrder(order.id);
      await loadOrder();
    } catch (err: any) {
      console.error('Erro ao aprovar pedido:', err);
      setActionError(getApiErrorMessage(err, 'Erro ao aprovar pedido'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!order) return;
    if (!confirm('Tem certeza que deseja cancelar este pedido?')) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await api.cancelPurchaseOrder(order.id);
      await loadOrder();
    } catch (err: any) {
      console.error('Erro ao cancelar pedido:', err);
      setActionError(getApiErrorMessage(err, 'Erro ao cancelar pedido'));
    } finally {
      setActionLoading(false);
    }
  };

  const openReceiveDialog = () => {
    if (!order) return;
    const defaults: Record<string, string> = {};
    order.items.forEach((item) => {
      const remaining = Number(item.quantity) - Number(item.receivedQuantity);
      defaults[item.id] = remaining > 0 ? String(remaining) : '0';
    });
    setReceiveQuantities(defaults);
    setInvoiceEnabled(false);
    setInvoice({ invoiceNumber: '', series: '', accessKey: '', issueDate: '', totalAmount: '' });
    setReceiveError(null);
    setReceiveOpen(true);
  };

  const handleReceiveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!order) return;
    setReceiveError(null);

    const itemsPayload = order.items
      .map((item) => {
        const qty = parseFloat(receiveQuantities[item.id] || '0');
        return { itemId: item.id, receivedQuantity: qty };
      })
      .filter((i) => i.receivedQuantity > 0);

    if (itemsPayload.length === 0) {
      setReceiveError('Informe a quantidade a receber de ao menos um item');
      return;
    }

    for (const item of order.items) {
      const remaining = Number(item.quantity) - Number(item.receivedQuantity);
      const qty = parseFloat(receiveQuantities[item.id] || '0');
      if (qty > remaining) {
        setReceiveError(`Quantidade recebida de "${item.product.name}" excede o restante (${remaining})`);
        return;
      }
    }

    let invoicePayload;
    if (invoiceEnabled) {
      if (!invoice.invoiceNumber || !invoice.series || !invoice.accessKey || !invoice.issueDate || !invoice.totalAmount) {
        setReceiveError('Preencha todos os campos da nota fiscal ou desmarque a opção');
        return;
      }
      invoicePayload = {
        invoiceNumber: invoice.invoiceNumber,
        series: invoice.series,
        accessKey: invoice.accessKey,
        // Mesmo achado de auditoria de financial/page.tsx (dueDate): <input
        // type="date"> devolve "YYYY-MM-DD" puro, que `new Date()`
        // interpreta como meia-noite UTC, não local — exibia um dia a
        // menos para usuários em UTC-3. "T23:59:59" (sem fuso, portanto
        // horário local) corrige.
        issueDate: new Date(`${invoice.issueDate}T23:59:59`).toISOString(),
        totalAmount: parseFloat(invoice.totalAmount),
      };
    }

    setReceiving(true);
    try {
      await api.receivePurchaseOrder(order.id, {
        branchId: order.branchId,
        items: itemsPayload,
        invoice: invoicePayload,
      });
      setReceiveOpen(false);
      await loadOrder();
    } catch (err: any) {
      console.error('Erro ao receber pedido:', err);
      setReceiveError(getApiErrorMessage(err, 'Erro ao registrar recebimento'));
    } finally {
      setReceiving(false);
    }
  };

  if (loading) {
    return <div className="p-12 text-center text-gray-500">Carregando...</div>;
  }

  if (error || !order) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/purchases">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <h1 className="text-3xl font-bold">Pedido de Compra</h1>
        </div>
        <Card className="p-12 text-center">
          <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">Erro ao carregar</h3>
          <p className="text-gray-500 mb-4">{error || 'Pedido não encontrado.'}</p>
          <Button variant="outline" onClick={loadOrder}>
            Tentar novamente
          </Button>
        </Card>
      </div>
    );
  }

  const canApprove = ['DRAFT', 'SENT'].includes(order.status);
  const canCancel = !['RECEIVED', 'CANCELLED'].includes(order.status);
  const canReceive = order.status === 'CONFIRMED';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/purchases">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold">Pedido #{order.poNumber}</h1>
              <Badge variant={STATUS_VARIANTS[order.status] ?? 'secondary'}>
                {STATUS_LABELS[order.status] ?? order.status}
              </Badge>
            </div>
            <p className="text-gray-500 mt-1">{order.supplier.name}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {canApprove && (
            <Button onClick={handleApprove} disabled={actionLoading}>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Aprovar
            </Button>
          )}
          {canReceive && (
            <Button onClick={openReceiveDialog} disabled={actionLoading}>
              <PackageCheck className="h-4 w-4 mr-2" />
              Receber
            </Button>
          )}
          {canCancel && (
            <Button variant="outline" onClick={handleCancel} disabled={actionLoading}>
              <XCircle className="h-4 w-4 mr-2" />
              Cancelar
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {actionError}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="p-6">
          <p className="text-sm text-gray-500">Fornecedor</p>
          <p className="font-medium mt-1">{order.supplier.name}</p>
          <p className="text-sm text-gray-500">{order.supplier.document}</p>
        </Card>
        <Card className="p-6">
          <p className="text-sm text-gray-500">Data do Pedido</p>
          <p className="font-medium mt-1">{new Date(order.orderDate).toLocaleDateString('pt-BR')}</p>
          <p className="text-sm text-gray-500">
            Previsão: {order.expectedDelivery ? new Date(order.expectedDelivery).toLocaleDateString('pt-BR') : '-'}
          </p>
        </Card>
        <Card className="p-6">
          <p className="text-sm text-gray-500">Total do Pedido</p>
          <p className="text-2xl font-bold mt-1">{formatCurrency(Number(order.totalAmount))}</p>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Itens</CardTitle>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead className="text-right">Qtd. Pedida</TableHead>
              <TableHead className="text-right">Qtd. Recebida</TableHead>
              <TableHead className="text-right">Restante</TableHead>
              <TableHead className="text-right">Custo Unit.</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.items.map((item) => {
              const remaining = Number(item.quantity) - Number(item.receivedQuantity);
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    <p className="font-medium">{item.product.name}</p>
                    <p className="text-xs text-gray-500">SKU: {item.product.sku}</p>
                  </TableCell>
                  <TableCell className="text-right">{Number(item.quantity)}</TableCell>
                  <TableCell className="text-right">{Number(item.receivedQuantity)}</TableCell>
                  <TableCell className="text-right">
                    {remaining > 0 ? (
                      <Badge variant="warning">{remaining}</Badge>
                    ) : (
                      <Badge variant="success">0</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(Number(item.unitCost))}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(Number(item.totalCost))}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {order.notes && (
        <Card className="p-6">
          <p className="text-sm text-gray-500 mb-1">Observações</p>
          <p className="text-sm">{order.notes}</p>
        </Card>
      )}

      {order.invoices && order.invoices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Notas Fiscais Recebidas</CardTitle>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead>Série</TableHead>
                <TableHead>Chave de Acesso</TableHead>
                <TableHead>Emissão</TableHead>
                <TableHead className="text-right">Valor Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.invoices.map((inv: any) => (
                <TableRow key={inv.id}>
                  <TableCell>{inv.invoiceNumber}</TableCell>
                  <TableCell>{inv.series}</TableCell>
                  <TableCell className="font-mono text-xs">{inv.accessKey}</TableCell>
                  <TableCell>{new Date(inv.issueDate).toLocaleDateString('pt-BR')}</TableCell>
                  <TableCell className="text-right">{formatCurrency(Number(inv.totalAmount))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={receiveOpen} onOpenChange={setReceiveOpen}>
        <DialogContent className="max-w-2xl" onClose={() => setReceiveOpen(false)}>
          <form onSubmit={handleReceiveSubmit}>
            <DialogHeader>
              <DialogTitle>Receber Pedido #{order.poNumber}</DialogTitle>
            </DialogHeader>
            <div className="p-6 space-y-4">
              {receiveError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {receiveError}
                </div>
              )}

              <p className="text-sm text-gray-500">
                Informe a quantidade recebida agora para cada item. É possível receber parcialmente —
                o restante poderá ser recebido em um próximo lote.
              </p>

              <div className="space-y-3">
                {order.items.map((item) => {
                  const remaining = Number(item.quantity) - Number(item.receivedQuantity);
                  return (
                    <div key={item.id} className="grid grid-cols-[1fr_140px] items-center gap-3">
                      <div>
                        <p className="text-sm font-medium">{item.product.name}</p>
                        <p className="text-xs text-gray-500">
                          Pedido: {Number(item.quantity)} · Recebido: {Number(item.receivedQuantity)} · Restante: {remaining}
                        </p>
                      </div>
                      <Input
                        type="number"
                        min="0"
                        max={remaining}
                        step="1"
                        disabled={remaining <= 0}
                        value={receiveQuantities[item.id] ?? '0'}
                        onChange={(e) =>
                          setReceiveQuantities((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                      />
                    </div>
                  );
                })}
              </div>

              <div className="border-t pt-4">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={invoiceEnabled}
                    onChange={(e) => setInvoiceEnabled(e.target.checked)}
                  />
                  Anexar nota fiscal deste recebimento
                </label>

                {invoiceEnabled && (
                  <div className="grid gap-3 md:grid-cols-2 mt-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Número da NF</label>
                      <Input
                        value={invoice.invoiceNumber}
                        onChange={(e) => setInvoice((prev) => ({ ...prev, invoiceNumber: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Série</label>
                      <Input
                        value={invoice.series}
                        onChange={(e) => setInvoice((prev) => ({ ...prev, series: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <label className="text-xs font-medium text-gray-500">Chave de Acesso</label>
                      <Input
                        maxLength={44}
                        value={invoice.accessKey}
                        onChange={(e) => setInvoice((prev) => ({ ...prev, accessKey: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Data de Emissão</label>
                      <Input
                        type="date"
                        value={invoice.issueDate}
                        onChange={(e) => setInvoice((prev) => ({ ...prev, issueDate: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Valor Total</label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={invoice.totalAmount}
                        onChange={(e) => setInvoice((prev) => ({ ...prev, totalAmount: e.target.value }))}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setReceiveOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={receiving}>
                {receiving ? 'Registrando...' : 'Confirmar Recebimento'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
