'use client';

import { useEffect, useState } from 'react';
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
import { Plus, Wrench, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

const STATUS_LABEL: Record<string, string> = {
  ENTRADA: 'Entrada',
  DIAGNOSTICO: 'Diagnóstico',
  ORCAMENTO: 'Orçamento',
  APROVACAO: 'Aguardando aprovação',
  EXECUCAO: 'Em execução',
  PRONTO: 'Pronto',
  ENTREGA: 'Entrega',
  ENCERRADA: 'Encerrada',
  CANCELADA: 'Cancelada',
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'error'> = {
  ENTRADA: 'secondary',
  DIAGNOSTICO: 'warning',
  ORCAMENTO: 'warning',
  APROVACAO: 'warning',
  EXECUCAO: 'default',
  PRONTO: 'success',
  ENTREGA: 'success',
  ENCERRADA: 'secondary',
  CANCELADA: 'error',
};

export default function ServiceOrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getServiceOrders({ status: statusFilter || undefined, limit: 50 });
      setOrders(result.orders ?? []);
    } catch (err) {
      console.error('Erro ao carregar ordens de serviço:', err);
      setError('Não foi possível carregar as ordens de serviço. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Oficina — Ordens de Serviço</h1>
          <p className="text-gray-500 mt-1">
            Entrada → Diagnóstico → Orçamento → Aprovação → Execução → Pronto → Entrega → Encerrada. Encerrar
            exige pagamento confirmado.
          </p>
        </div>
        <Link href="/dashboard/service-orders/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Nova OS
          </Button>
        </Link>
      </div>

      <div className="w-64">
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Todos os status</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando...</div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
            <p className="text-gray-500 mb-4">{error}</p>
            <Button variant="outline" onClick={load}>
              Tentar novamente
            </Button>
          </div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center">
            <Wrench className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhuma ordem de serviço</h3>
            <p className="text-gray-500 mb-4">Abra uma OS quando um veículo entrar na oficina.</p>
            <Link href="/dashboard/service-orders/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Nova OS
              </Button>
            </Link>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>OS</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Moto</TableHead>
                <TableHead>Mecânico</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Entrada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((os) => (
                <TableRow key={os.id} className="cursor-pointer hover:bg-gray-50">
                  <TableCell className="font-medium">
                    <Link href={`/dashboard/service-orders/${os.id}`} className="text-blue-600 hover:underline">
                      #{os.osNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{os.customer?.name}</TableCell>
                  <TableCell>
                    {os.motorcycle ? `${os.motorcycle.brand} ${os.motorcycle.model}` : '-'}
                  </TableCell>
                  <TableCell>{os.mechanic?.name ?? '-'}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[os.status] ?? 'secondary'}>{STATUS_LABEL[os.status] ?? os.status}</Badge>
                  </TableCell>
                  <TableCell>{new Date(os.createdAt).toLocaleDateString('pt-BR')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
