'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { Plus, ClipboardList, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { clampPage } from '@/lib/list-pagination';

const PAGE_SIZE = 20;

interface PurchaseOrderItem {
  id: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
}

interface PurchaseOrder {
  id: string;
  poNumber: number;
  status: 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED' | 'CANCELLED';
  totalAmount: number;
  expectedDelivery?: string | null;
  orderDate: string;
  supplier?: { id: string; name: string } | null;
  items?: PurchaseOrderItem[];
  // A listagem devolve só a contagem (não as linhas dos itens).
  _count?: { items: number };
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

export default function PurchasesPage() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  // A API pagina (default 20) e devolve `pagination`; a tela descartava e o
  // rodapé "Mostrando N pedido(s)" parecia o total, escondendo os demais.
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{ page: number; pages: number; total: number } | null>(null);

  const loadOrders = async (status?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getPurchaseOrders({ ...(status ? { status } : {}), page, limit: PAGE_SIZE });
      // A página atual pode ter deixado de existir (ex.: a última linha dela foi
      // paga/cancelada): volta para a última página válida em vez de mostrar
      // uma tela vazia sem controle de paginação.
      const target = clampPage(page, result?.pagination?.pages);
      if (target !== page) {
        setPage(target);
        return;
      }
      setOrders(result?.orders ?? []);
      setPagination(result?.pagination ?? null);
    } catch (err) {
      console.error('Erro ao carregar pedidos de compra:', err);
      setError('Não foi possível carregar os pedidos de compra. Tente novamente.');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  };

  // Trocar o filtro volta para a página 1 (no onChange do filtro) — a página 3
  // de um filtro novo pode nem existir. Um único efeito cobre filtro e página.
  useEffect(() => {
    loadOrders(statusFilter || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, page]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Compras</h1>
          <p className="text-gray-500 mt-1">Gerencie os pedidos de compra a fornecedores</p>
        </div>
        <Link href="/dashboard/purchases/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Novo Pedido
          </Button>
        </Link>
      </div>

      <Card>
        <div className="p-6 border-b">
          <div className="flex items-center gap-4">
            <div className="w-56">
              <Select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Todos os status</option>
                <option value="DRAFT">Rascunho</option>
                <option value="SENT">Enviado</option>
                <option value="CONFIRMED">Confirmado</option>
                <option value="RECEIVED">Recebido</option>
                <option value="CANCELLED">Cancelado</option>
              </Select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando...</div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Erro ao carregar</h3>
            <p className="text-gray-500 mb-4">{error}</p>
            <Button variant="outline" onClick={() => loadOrders(statusFilter || undefined)}>
              Tentar novamente
            </Button>
          </div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center">
            <ClipboardList className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Nenhum pedido de compra encontrado
            </h3>
            <p className="text-gray-500 mb-4">
              {statusFilter
                ? 'Tente ajustar o filtro de status'
                : 'Comece criando seu primeiro pedido de compra'}
            </p>
            <Link href="/dashboard/purchases/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Novo Pedido
              </Button>
            </Link>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nº</TableHead>
                <TableHead>Fornecedor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Itens</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Previsão de Entrega</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="font-medium">#{order.poNumber}</TableCell>
                  <TableCell>{order.supplier?.name ?? '-'}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[order.status] ?? 'secondary'}>
                      {STATUS_LABELS[order.status] ?? order.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{order._count?.items ?? order.items?.length ?? '-'}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(Number(order.totalAmount ?? 0))}
                  </TableCell>
                  <TableCell>
                    {order.expectedDelivery
                      ? new Date(order.expectedDelivery).toLocaleDateString('pt-BR')
                      : '-'}
                  </TableCell>
                  <TableCell>
                    <Link href={`/dashboard/purchases/${order.id}`}>
                      <Button variant="ghost" size="sm">
                        Ver
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!loading && !error && orders.length > 0 && (
          <Pagination
            page={pagination?.page ?? page}
            pages={pagination?.pages ?? 1}
            total={pagination?.total ?? orders.length}
            itemCount={orders.length}
            onPageChange={setPage}
            itemLabel="pedidos"
          />
        )}
      </Card>
    </div>
  );
}
