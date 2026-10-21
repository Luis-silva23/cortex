'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Search,
  Eye,
  XCircle,
  Filter,
  ShoppingCart,
  DollarSign,
  TrendingUp,
  Calendar,
} from 'lucide-react';
import Link from 'next/link';
import { api, getCurrentUserClaims } from '@/lib/api';
import { CancelSaleDialog } from '@/components/sales/CancelSaleDialog';
import { canCancelSale } from '@/lib/sales';
import { Pagination } from '@/components/ui/pagination';
import { useDebounce } from '@/lib/hooks/useDebounce';

const STATUS_LABELS: Record<string, string> = {
  PAID: 'Concluída',
  PARTIALLY_PAID: 'Parcial',
  PENDING: 'Pendente',
  CANCELLED: 'Cancelada',
  RETURNED: 'Devolvida',
};

const paymentMethodLabel = (method?: string) => {
  const labels: Record<string, string> = {
    CASH: 'Dinheiro',
    DEBIT_CARD: 'Cartão de Débito',
    CREDIT_CARD: 'Cartão de Crédito',
    PIX: 'PIX',
    BANK_TRANSFER: 'Transferência',
    CHECK: 'Cheque',
    VOUCHER: 'Vale',
    OTHER: 'Outro',
  };
  return method ? labels[method] ?? method : '-';
};

export default function SalesPage() {
  const [searchTerm, setSearchTerm] = useState('');
  // A busca é feita no servidor (número ou cliente, em TODAS as páginas); antes
  // a tela filtrava só as 20 vendas da página carregada.
  const debouncedSearch = useDebounce(searchTerm.trim(), 400);
  const [statusFilter, setStatusFilter] = useState('all');
  const [sales, setSales] = useState<any[]>([]);
  const [pagination, setPagination] = useState<{ page: number; pages: number; total: number } | null>(null);
  const [page, setPage] = useState(1);
  const [statsSummary, setStatsSummary] = useState({
    total: 0,
    revenue: 0,
    pending: 0,
    avgTicket: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);

  useEffect(() => {
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadSales();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // Trocar o filtro de status ou o termo de busca volta pra página 1 (senão a
  // página 3 de um filtro novo pode simplesmente não existir) — só recarrega
  // direto quando já está na página 1, senão setPage(1) já dispara o efeito acima.
  useEffect(() => {
    if (page === 1) {
      loadSales();
    } else {
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, debouncedSearch]);

  const loadSales = async () => {
    setLoading(true);
    setError(null);
    try {
      const params: any = { page, limit: 20 };
      if (statusFilter !== 'all') {
        params.status = statusFilter;
      }
      if (debouncedSearch) {
        params.search = debouncedSearch;
      }
      const result = await api.getSales(params);
      setSales(result?.sales ?? []);
      setPagination(result?.pagination ?? null);
    } catch (err) {
      console.error('Erro ao carregar vendas:', err);
      setError('Não foi possível carregar as vendas.');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const stats = await api.getSalesStats();
      setStatsSummary({
        total: stats?.totalSales ?? 0,
        revenue: stats?.totalRevenue ?? 0,
        pending: 0,
        avgTicket: stats?.avgTicket ?? 0,
      });
    } catch (err) {
      console.error('Erro ao carregar estatísticas de vendas:', err);
    }
  };

  // Cancelar venda exige dupla autorização (motivo + credenciais de um
  // responsável): o diálogo coleta tudo e mostra a mensagem exata da API. Antes
  // era window.prompt só com o motivo, e a API sempre respondia 400.
  const userType = getCurrentUserClaims()?.userType ?? null;
  const handleCancel = (sale: any) => setCancelTarget(sale);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PAID':
        return 'bg-green-100 text-green-700';
      case 'PARTIALLY_PAID':
      case 'PENDING':
        return 'bg-yellow-100 text-yellow-700';
      case 'CANCELLED':
        return 'bg-red-100 text-red-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Vendas</h1>
          <p className="text-gray-500 mt-1">Acompanhe todas as vendas realizadas</p>
        </div>
      </div>

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 text-sm text-red-700">{error}</Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Vendas Concluídas</p>
              <p className="text-2xl font-bold mt-1">{statsSummary.total}</p>
            </div>
            <ShoppingCart className="h-10 w-10 text-blue-600 opacity-20" />
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Receita Total</p>
              <p className="text-2xl font-bold mt-1">
                {formatCurrency(statsSummary.revenue)}
              </p>
            </div>
            <DollarSign className="h-10 w-10 text-green-600 opacity-20" />
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Ticket Médio</p>
              <p className="text-2xl font-bold mt-1">
                {formatCurrency(statsSummary.avgTicket)}
              </p>
            </div>
            <TrendingUp className="h-10 w-10 text-muted-foreground opacity-20" />
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total de Vendas (página)</p>
              <p className="text-2xl font-bold mt-1">{pagination?.total ?? sales.length}</p>
            </div>
            <Calendar className="h-10 w-10 text-yellow-600 opacity-20" />
          </div>
        </Card>
      </div>

      <Card>
        <div className="p-6 border-b">
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Buscar por número ou cliente..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full sm:w-48"
            >
              <option value="all">Todos os Status</option>
              <option value="PAID">Concluída</option>
              <option value="PENDING">Pendente</option>
              <option value="PARTIALLY_PAID">Parcial</option>
              <option value="CANCELLED">Cancelada</option>
            </Select>
            <Button variant="outline" size="sm" disabled title="Filtros avançados em desenvolvimento">
              <Filter className="h-4 w-4 mr-2" />
              Mais Filtros
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando vendas...</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Data/Hora</TableHead>
                <TableHead>Itens</TableHead>
                <TableHead>Pagamento</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.map((sale) => (
                <TableRow key={sale.id}>
                  <TableCell className="font-medium">
                    #{String(sale.saleNumber ?? '').padStart(6, '0')}
                  </TableCell>
                  <TableCell>{sale.customer?.name ?? 'Sem cliente'}</TableCell>
                  <TableCell className="text-sm text-gray-600">
                    {sale.saleDate ? new Date(sale.saleDate).toLocaleString('pt-BR') : '-'}
                  </TableCell>
                  <TableCell>{sale.items?.length ?? 0}</TableCell>
                  <TableCell className="text-sm">
                    {paymentMethodLabel(sale.payments?.[0]?.paymentMethod)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(Number(sale.totalAmount ?? 0))}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(
                        sale.status
                      )}`}
                    >
                      {STATUS_LABELS[sale.status] ?? sale.status}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Link href={`/dashboard/sales/${sale.id}`}>
                        <Button variant="ghost" size="icon" title="Ver detalhes">
                          <Eye className="h-4 w-4" />
                        </Button>
                      </Link>
                      {canCancelSale(sale, userType) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Cancelar venda"
                          aria-label={`Cancelar venda ${sale.saleNumber}`}
                          onClick={() => handleCancel(sale)}
                        >
                          <XCircle className="h-4 w-4 text-red-600" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {sales.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-gray-500 py-8">
                    Nenhuma venda encontrada
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}

        <Pagination
          page={pagination?.page ?? page}
          pages={pagination?.pages ?? 1}
          total={pagination?.total ?? sales.length}
          itemCount={sales.length}
          onPageChange={setPage}
          itemLabel="vendas"
        />
      </Card>

      <CancelSaleDialog
        open={cancelTarget !== null}
        sale={cancelTarget}
        hadApprovedPayment={(cancelTarget?.payments ?? []).some((p: any) => p.status === 'APPROVED')}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        onCancelled={() => {
          Promise.all([loadSales(), loadStats()]);
        }}
      />
    </div>
  );
}
