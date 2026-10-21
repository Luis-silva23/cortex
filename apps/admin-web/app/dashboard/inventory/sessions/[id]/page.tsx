'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Plus, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { useUserType } from '@/lib/hooks/useUserType';
import { MANAGER_ONLY_NOTICE, isManagerOrAbove } from '@/lib/role-gates';
import { ProductPicker, type ProductOption } from '@/components/service-orders/ProductPicker';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho',
  IN_PROGRESS: 'Em andamento',
  COMPLETED: 'Concluído',
  CANCELLED: 'Cancelado',
};
const STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success' | 'error'> = {
  DRAFT: 'secondary',
  IN_PROGRESS: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'error',
};

export default function InventorySessionDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [inventory, setInventory] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Produto da contagem escolhido por BUSCA no servidor: a lista fixa de 300
  // produtos era cortada em 100 pela API e o restante do catálogo não dava para
  // contar.
  const [countProduct, setCountProduct] = useState<ProductOption | null>(null);
  const [countedQuantity, setCountedQuantity] = useState('');
  const [countNotes, setCountNotes] = useState('');
  const [countSaving, setCountSaving] = useState(false);

  // Fechar e cancelar inventário exigem Gerente+ (a API responde 403 para os
  // demais); contar segue aberto a quem opera o estoque.
  const { userType, ready: roleReady } = useUserType();
  const canDecide = isManagerOrAbove(userType);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getInventory(id);
      setInventory(result);
    } catch (err) {
      console.error('Erro ao carregar inventário:', err);
      setError('Não foi possível carregar o inventário.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function addCount() {
    setActionError(null);
    if (!countProduct || countedQuantity === '') {
      setActionError('Produto e quantidade contada são obrigatórios');
      return;
    }
    setCountSaving(true);
    try {
      await api.addInventoryCount(id, countProduct.id, Number(countedQuantity), countNotes || undefined);
      setCountProduct(null);
      setCountedQuantity('');
      setCountNotes('');
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao registrar contagem'));
    } finally {
      setCountSaving(false);
    }
  }

  async function close() {
    if (!window.confirm('Fechar o inventário? Isso gera ajustes de estoque reais para todo produto com divergência.')) return;
    setActionError(null);
    try {
      await api.closeInventory(id);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao fechar inventário'));
    }
  }

  async function cancel() {
    const reason = window.prompt('Motivo do cancelamento:');
    if (!reason) return;
    setActionError(null);
    try {
      await api.cancelInventory(id, reason);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao cancelar inventário'));
    }
  }

  if (loading) return <div className="p-12 text-center text-gray-500">Carregando...</div>;
  if (error || !inventory)
    return (
      <div className="p-12 text-center">
        <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
        <p className="text-gray-500 mb-4">{error || 'Inventário não encontrado.'}</p>
        <Link href="/dashboard/inventory">
          <Button variant="outline">Voltar</Button>
        </Link>
      </div>
    );

  const isOpen = inventory.status === 'IN_PROGRESS';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/inventory">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-gray-900">Inventário #{inventory.inventoryNumber}</h1>
            <Badge variant={STATUS_VARIANT[inventory.status] ?? 'secondary'}>{STATUS_LABEL[inventory.status] ?? inventory.status}</Badge>
          </div>
          <p className="text-gray-500 mt-1">Iniciado em {new Date(inventory.startedAt).toLocaleString('pt-BR')}</p>
        </div>
        {isOpen && canDecide && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={cancel}>
              Cancelar
            </Button>
            <Button onClick={close} disabled={!inventory.counts?.length}>
              Fechar e aplicar ajustes
            </Button>
          </div>
        )}
      </div>

      {isOpen && roleReady && !canDecide && (
        <Alert>
          <AlertDescription>
            {MANAGER_ONLY_NOTICE} Você pode registrar contagens, mas fechar (aplicar os ajustes de estoque) ou cancelar
            o inventário é decisão de Gerente ou Administrador.
          </AlertDescription>
        </Alert>
      )}

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>
      )}

      {isOpen && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Registrar contagem</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Produto</Label>
              <ProductPicker value={countProduct} onChange={setCountProduct} showPrice={false} />
            </div>
            <div className="flex gap-2 items-end flex-wrap">
              <div className="space-y-1 w-32">
                <Label>Qtd. contada</Label>
                <Input type="number" value={countedQuantity} onChange={(e) => setCountedQuantity(e.target.value)} />
              </div>
              <div className="space-y-1 flex-1 min-w-[180px]">
                <Label>Observações (opcional)</Label>
                <Input value={countNotes} onChange={(e) => setCountNotes(e.target.value)} />
              </div>
              <Button onClick={addCount} disabled={countSaving}>
                <Plus className="h-4 w-4 mr-2" />
                {countSaving ? 'Salvando...' : 'Registrar'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Contagens ({inventory.counts?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {inventory.counts?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>Sistema</TableHead>
                  <TableHead>Contado</TableHead>
                  <TableHead>Diferença</TableHead>
                  <TableHead>Contado em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inventory.counts.map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.product?.name} ({c.product?.sku})
                    </TableCell>
                    <TableCell>{c.systemQuantity}</TableCell>
                    <TableCell>{c.countedQuantity}</TableCell>
                    <TableCell>
                      <span className={Number(c.difference) === 0 ? 'text-gray-500' : Number(c.difference) > 0 ? 'text-green-600' : 'text-red-600'}>
                        {Number(c.difference) > 0 ? '+' : ''}
                        {c.difference}
                      </span>
                    </TableCell>
                    <TableCell>{new Date(c.countedAt).toLocaleString('pt-BR')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-gray-500 py-6 text-center">Nenhuma contagem registrada ainda.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
