'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Pagination } from '@/components/ui/pagination';
import { Plus, AlertTriangle, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { clampPage } from '@/lib/list-pagination';
import { getApiErrorMessage } from '@/lib/errors';
import { useUserType } from '@/lib/hooks/useUserType';
import { MANAGER_ONLY_NOTICE, isManagerOrAbove } from '@/lib/role-gates';
import { ProductPicker, type ProductOption } from '@/components/service-orders/ProductPicker';

const PAGE_SIZE = 50;

const REASON_LABEL: Record<string, string> = {
  EXPIRED: 'Vencido',
  DAMAGED: 'Danificado',
  LOST: 'Extraviado',
  THEFT: 'Furto/Roubo',
};

export default function DamagePage() {
  const [damages, setDamages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reversedFilter, setReversedFilter] = useState('');
  // A API devolve `pagination` (default 100 por página) e a tela descartava:
  // acima do limite, os registros mais antigos ficavam inacessíveis.
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{ page: number; pages: number; total: number } | null>(null);

  // Registrar e reverter avaria exigem Gerente+ (a API responde 403 para os
  // demais) — a tela só oferece essas ações a quem pode; a API segue sendo a
  // autoridade.
  const { userType, ready: roleReady } = useUserType();
  const canManage = isManagerOrAbove(userType);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  // Produto escolhido por BUSCA no servidor: a lista fixa de 300 produtos era
  // cortada em 100 pela API e o restante do catálogo não dava para selecionar.
  const [product, setProduct] = useState<ProductOption | null>(null);
  const [branchId, setBranchId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('DAMAGED');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [reverseTarget, setReverseTarget] = useState<any>(null);
  const [reverseReason, setReverseReason] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getDamageRecordsPage({
        isReversed: reversedFilter === '' ? undefined : reversedFilter === 'true',
        page,
        limit: PAGE_SIZE,
      });
      // A página atual pode ter deixado de existir (ex.: a última linha dela foi
      // paga/cancelada): volta para a última página válida em vez de mostrar
      // uma tela vazia sem controle de paginação.
      const target = clampPage(page, result?.pagination?.pages);
      if (target !== page) {
        setPage(target);
        return;
      }
      setDamages(result?.damages ?? []);
      setPagination(result?.pagination ?? null);
    } catch (err) {
      console.error('Erro ao carregar avarias:', err);
      setError('Não foi possível carregar os registros de avaria. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  // Trocar o filtro também volta para a página 1 (no onChange do filtro) — a
  // página 3 de um filtro novo pode nem existir. Um único efeito cobre os dois.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reversedFilter, page]);

  function openNew() {
    setBranchId('');
    setProduct(null);
    setQuantity('1');
    setReason('DAMAGED');
    setDescription('');
    setFormError(null);
    setDialogOpen(true);
    if (branches.length === 0) {
      api.getBranches().then((res) => setBranches(res?.data ?? [])).catch(() => setBranches([]));
    }
  }

  async function save() {
    setFormError(null);
    if (!branchId || !product || Number(quantity) <= 0) {
      setFormError('Filial, produto e quantidade (maior que zero) são obrigatórios');
      return;
    }
    setSaving(true);
    try {
      await api.createDamageRecord({
        branchId,
        productId: product.id,
        quantity: Number(quantity),
        reason: reason as any,
        description: description || undefined,
      });
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao registrar avaria'));
    } finally {
      setSaving(false);
    }
  }

  async function submitReverse() {
    if (!reverseTarget || !reverseReason.trim()) return;
    try {
      await api.reverseDamageRecord(reverseTarget.id, reverseReason);
      setReverseTarget(null);
      setReverseReason('');
      await load();
    } catch (err: any) {
      alert(getApiErrorMessage(err, 'Erro ao estornar avaria'));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Avarias</h1>
          <p className="text-gray-500 mt-1">
            Registrar já exige Gerente/Admin — a permissão para chegar aqui é a aprovação. Baixa real de estoque
            (tipo LOSS) na hora do registro.
          </p>
        </div>
        {canManage && (
          <Button onClick={openNew}>
            <Plus className="h-4 w-4 mr-2" />
            Registrar Avaria
          </Button>
        )}
      </div>

      {roleReady && !canManage && (
        <Alert>
          <AlertDescription>
            {MANAGER_ONLY_NOTICE} Você pode consultar as avarias, mas registrar ou reverter uma avaria é decisão de
            Gerente ou Administrador.
          </AlertDescription>
        </Alert>
      )}

      <div className="w-64">
        <Select
          value={reversedFilter}
          onChange={(e) => {
            setReversedFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Todos</option>
          <option value="false">Ativas</option>
          <option value="true">Revertidas</option>
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
        ) : damages.length === 0 ? (
          <div className="p-12 text-center">
            <AlertTriangle className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhum registro de avaria</h3>
            <p className="text-gray-500">Perdas por vencimento, dano, extravio ou furto aparecem aqui.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead>Quantidade</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead>Registrado em</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {damages.map((d: any) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">
                    {d.product?.name} ({d.product?.sku})
                  </TableCell>
                  <TableCell>{d.quantity}</TableCell>
                  <TableCell>{REASON_LABEL[d.reason] ?? d.reason}</TableCell>
                  <TableCell>{new Date(d.recordedAt).toLocaleString('pt-BR')}</TableCell>
                  <TableCell>
                    <Badge variant={d.isReversed ? 'secondary' : 'error'}>{d.isReversed ? 'Revertida' : 'Ativa'}</Badge>
                  </TableCell>
                  <TableCell>
                    {!d.isReversed && canManage && (
                      <Button size="sm" variant="outline" onClick={() => setReverseTarget(d)}>
                        Reverter
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!loading && !error && damages.length > 0 && (
          <Pagination
            page={pagination?.page ?? page}
            pages={pagination?.pages ?? 1}
            total={pagination?.total ?? damages.length}
            itemCount={damages.length}
            onPageChange={setPage}
            itemLabel="registros"
          />
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar Avaria</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="space-y-1">
              <Label>Filial</Label>
              <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Selecione...</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Produto</Label>
              <ProductPicker value={product} onChange={setProduct} showPrice={false} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Quantidade</Label>
                <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Motivo</Label>
                <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {Object.entries(REASON_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Descrição (opcional)</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Salvando...' : 'Registrar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!reverseTarget} onOpenChange={(open) => !open && setReverseTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverter avaria</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-amber-600">Devolve a quantidade ao estoque. Exige motivo.</p>
            <div className="space-y-1">
              <Label>Motivo</Label>
              <Input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={submitReverse} disabled={!reverseReason.trim()}>
              Reverter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
