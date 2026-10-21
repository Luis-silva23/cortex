'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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
import { Plus, Boxes, ClipboardCheck, ArrowLeftRight, AlertCircle } from 'lucide-react';
import { api, getCurrentUserClaims } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { ProductPicker, type ProductOption } from '@/components/service-orders/ProductPicker';

const STOCK_STATUS_LABEL: Record<string, string> = {
  NOT_INVENTORIED: 'Nunca inventariado',
  OUT_OF_STOCK: 'Sem estoque',
  LOW_STOCK: 'Estoque baixo',
  OK: 'OK',
};
const STOCK_STATUS_VARIANT: Record<string, 'secondary' | 'error' | 'warning' | 'success'> = {
  NOT_INVENTORIED: 'secondary',
  OUT_OF_STOCK: 'error',
  LOW_STOCK: 'warning',
  OK: 'success',
};

export default function InventoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Estoque, Inventário e Transferências</h1>
        <p className="text-gray-500 mt-1">
          Ajuste avulso é imediato; inventário físico segue planejamento → contagem → fechamento; transferência
          entre filiais segue solicitação → aprovação → envio → recebimento.
        </p>
      </div>

      <Tabs defaultValue="stock">
        <TabsList>
          <TabsTrigger value="stock">
            <Boxes className="h-4 w-4 mr-1 inline" /> Estoque
          </TabsTrigger>
          <TabsTrigger value="counts">
            <ClipboardCheck className="h-4 w-4 mr-1 inline" /> Inventário Físico
          </TabsTrigger>
          <TabsTrigger value="transfers">
            <ArrowLeftRight className="h-4 w-4 mr-1 inline" /> Transferências
          </TabsTrigger>
        </TabsList>
        <TabsContent value="stock">
          <StockPanel />
        </TabsContent>
        <TabsContent value="counts">
          <InventorySessionsPanel />
        </TabsContent>
        <TabsContent value="transfers">
          <TransfersPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StockPanel() {
  const [report, setReport] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const [adjustDialogOpen, setAdjustDialogOpen] = useState(false);
  // Produto escolhido por BUSCA no servidor: a lista fixa de 300 produtos era
  // cortada em 100 pela API e o restante do catálogo não dava para ajustar.
  const [adjustProduct, setAdjustProduct] = useState<ProductOption | null>(null);
  const [adjustNewQuantity, setAdjustNewQuantity] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustSaving, setAdjustSaving] = useState(false);
  // O ajuste é sempre de UMA filial (a API recusa sem filial: o saldo seria o total da
  // empresa e o movimento ficaria fora de qualquer filial). Quem tem filial no token
  // (gerente/operador) ajusta a sua; administrador da empresa escolhe uma.
  const [needsBranch, setNeedsBranch] = useState(false);
  const [adjustBranches, setAdjustBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [adjustBranchId, setAdjustBranchId] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getStockReport({ status: statusFilter || undefined });
      setReport(result.items ?? []);
    } catch (err) {
      console.error('Erro ao carregar relatório de estoque:', err);
      setError('Não foi possível carregar o relatório de estoque. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function openAdjust() {
    setAdjustProduct(null);
    setAdjustNewQuantity('');
    setAdjustReason('');
    setAdjustError(null);
    setAdjustBranchId('');
    const withoutBranch = !getCurrentUserClaims()?.branchId;
    setNeedsBranch(withoutBranch);
    if (withoutBranch && adjustBranches.length === 0) {
      api
        .getBranches()
        .then((res) => setAdjustBranches((res?.data ?? []).filter((b: any) => b.isActive !== false).map((b: any) => ({ id: b.id, name: b.name }))))
        .catch((err) => setAdjustError(getApiErrorMessage(err, 'Não foi possível carregar as filiais.')));
    }
    setAdjustDialogOpen(true);
  }

  async function saveAdjust() {
    setAdjustError(null);
    if (!adjustProduct || adjustNewQuantity === '' || !adjustReason.trim()) {
      setAdjustError('Produto, nova quantidade e motivo são obrigatórios');
      return;
    }
    if (needsBranch && !adjustBranchId) {
      setAdjustError('Escolha a filial do ajuste');
      return;
    }
    setAdjustSaving(true);
    try {
      await api.adjustStock({
        productId: adjustProduct.id,
        ...(needsBranch ? { branchId: adjustBranchId } : {}),
        newQuantity: Number(adjustNewQuantity),
        reason: adjustReason,
      });
      setAdjustDialogOpen(false);
      await load();
    } catch (err: any) {
      setAdjustError(getApiErrorMessage(err, 'Erro ao ajustar estoque'));
    } finally {
      setAdjustSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="w-64">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Todos os status</option>
            {Object.entries(STOCK_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={openAdjust}>
          <Plus className="h-4 w-4 mr-2" />
          Ajuste avulso
        </Button>
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
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Produto</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Saldo</TableHead>
                <TableHead>Mín / Máx</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.map((r: any) => (
                <TableRow key={r.product.id}>
                  <TableCell className="font-mono text-xs">{r.product.sku}</TableCell>
                  <TableCell className="font-medium">{r.product.name}</TableCell>
                  <TableCell>{r.product.category ?? '-'}</TableCell>
                  <TableCell>{r.stock.balance}</TableCell>
                  <TableCell>
                    {r.stock.minStock} / {r.stock.maxStock ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STOCK_STATUS_VARIANT[r.stock.status] ?? 'secondary'}>
                      {STOCK_STATUS_LABEL[r.stock.status] ?? r.stock.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={adjustDialogOpen} onOpenChange={setAdjustDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ajuste avulso de estoque</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {adjustError && <p className="text-sm text-red-600">{adjustError}</p>}
            <p className="text-xs text-gray-400">
              Para uma contagem física completa com histórico e aprovação, use a aba Inventário Físico.
            </p>
            {needsBranch && (
              <div className="space-y-1">
                <Label>Filial</Label>
                <Select value={adjustBranchId} onChange={(e) => setAdjustBranchId(e.target.value)}>
                  <option value="">Selecione a filial...</option>
                  {adjustBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Produto</Label>
              <ProductPicker value={adjustProduct} onChange={setAdjustProduct} showPrice={false} />
            </div>
            <div className="space-y-1">
              <Label>Novo saldo</Label>
              <Input type="number" value={adjustNewQuantity} onChange={(e) => setAdjustNewQuantity(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Motivo</Label>
              <Input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="Ex: perda não registrada" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveAdjust} disabled={adjustSaving}>
              {adjustSaving ? 'Salvando...' : 'Ajustar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const INVENTORY_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho',
  IN_PROGRESS: 'Em andamento',
  COMPLETED: 'Concluído',
  CANCELLED: 'Cancelado',
};
const INVENTORY_STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success' | 'error'> = {
  DRAFT: 'secondary',
  IN_PROGRESS: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'error',
};

function InventorySessionsPanel() {
  const [inventories, setInventories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [branchId, setBranchId] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getInventories();
      setInventories(result ?? []);
    } catch (err) {
      console.error('Erro ao carregar inventários:', err);
      setError('Não foi possível carregar os inventários. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNew() {
    setBranchId('');
    setNotes('');
    setFormError(null);
    setDialogOpen(true);
    if (branches.length === 0) {
      api
        .getBranches()
        .then((res) => setBranches(res?.data ?? []))
        .catch(() => setBranches([]));
    }
  }

  async function save() {
    setFormError(null);
    if (!branchId) {
      setFormError('Filial é obrigatória');
      return;
    }
    setSaving(true);
    try {
      const inv = await api.startInventory(branchId, notes || undefined);
      setDialogOpen(false);
      window.location.href = `/dashboard/inventory/sessions/${inv.id}`;
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao iniciar inventário'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Iniciar Inventário
        </Button>
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
        ) : inventories.length === 0 ? (
          <div className="p-12 text-center">
            <ClipboardCheck className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhum inventário</h3>
            <p className="text-gray-500">Inicie uma contagem física para uma filial.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Itens contados</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Iniciado em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inventories.map((inv: any) => (
                <TableRow key={inv.id} className="cursor-pointer hover:bg-gray-50">
                  <TableCell className="font-medium">
                    <Link href={`/dashboard/inventory/sessions/${inv.id}`} className="text-blue-600 hover:underline">
                      #{inv.inventoryNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{inv._count?.counts ?? 0}</TableCell>
                  <TableCell>
                    <Badge variant={INVENTORY_STATUS_VARIANT[inv.status] ?? 'secondary'}>
                      {INVENTORY_STATUS_LABEL[inv.status] ?? inv.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{new Date(inv.startedAt).toLocaleString('pt-BR')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Iniciar Inventário</DialogTitle>
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
              <Label>Observações (opcional)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Iniciando...' : 'Iniciar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const TRANSFER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  IN_TRANSIT: 'Em trânsito',
  RECEIVED: 'Recebida',
  CANCELLED: 'Cancelada',
};
const TRANSFER_STATUS_VARIANT: Record<string, 'warning' | 'default' | 'success' | 'error'> = {
  PENDING: 'warning',
  IN_TRANSIT: 'default',
  RECEIVED: 'success',
  CANCELLED: 'error',
};

function TransfersPanel() {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [fromBranchId, setFromBranchId] = useState('');
  const [toBranchId, setToBranchId] = useState('');
  // Produto do item escolhido por BUSCA no servidor (a lista fixa de 300 era
  // cortada em 100 pela API).
  const [itemProduct, setItemProduct] = useState<ProductOption | null>(null);
  const [itemQuantity, setItemQuantity] = useState('1');
  const [items, setItems] = useState<Array<{ productId: string; productLabel: string; quantity: number }>>([]);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getTransfers();
      setTransfers(result ?? []);
    } catch (err) {
      console.error('Erro ao carregar transferências:', err);
      setError('Não foi possível carregar as transferências. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNew() {
    setFromBranchId('');
    setToBranchId('');
    setItems([]);
    setItemProduct(null);
    setItemQuantity('1');
    setNotes('');
    setFormError(null);
    setDialogOpen(true);
    if (branches.length === 0) {
      api.getBranches().then((res) => setBranches(res?.data ?? [])).catch(() => setBranches([]));
    }
  }

  function addItem() {
    if (!itemProduct || Number(itemQuantity) <= 0) return;
    setItems([
      ...items,
      {
        productId: itemProduct.id,
        productLabel: itemProduct.sku ? `${itemProduct.name} (${itemProduct.sku})` : itemProduct.name,
        quantity: Number(itemQuantity),
      },
    ]);
    setItemProduct(null);
    setItemQuantity('1');
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index));
  }

  async function save() {
    setFormError(null);
    if (!fromBranchId || !toBranchId) {
      setFormError('Filial de origem e destino são obrigatórias');
      return;
    }
    if (fromBranchId === toBranchId) {
      setFormError('Filial de origem e destino não podem ser a mesma');
      return;
    }
    if (items.length === 0) {
      setFormError('Adicione ao menos um item');
      return;
    }
    setSaving(true);
    try {
      await api.requestTransfer({
        fromBranchId,
        toBranchId,
        items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        notes: notes || undefined,
      });
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao solicitar transferência'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Solicitar Transferência
        </Button>
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
        ) : transfers.length === 0 ? (
          <div className="p-12 text-center">
            <ArrowLeftRight className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhuma transferência</h3>
            <p className="text-gray-500">Solicite o envio de produtos entre filiais.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Itens</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Solicitada em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.map((t: any) => (
                <TableRow key={t.id} className="cursor-pointer hover:bg-gray-50">
                  <TableCell className="font-medium">
                    <Link href={`/dashboard/inventory/transfers/${t.id}`} className="text-blue-600 hover:underline">
                      #{t.transferNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{t.items?.length ?? 0}</TableCell>
                  <TableCell>
                    <Badge variant={TRANSFER_STATUS_VARIANT[t.status] ?? 'secondary'}>
                      {TRANSFER_STATUS_LABEL[t.status] ?? t.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{new Date(t.requestedAt).toLocaleString('pt-BR')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Solicitar Transferência</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Filial de origem</Label>
                <Select value={fromBranchId} onChange={(e) => setFromBranchId(e.target.value)}>
                  <option value="">Selecione...</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Filial de destino</Label>
                <Select value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
                  <option value="">Selecione...</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Itens</Label>
              {items.map((item, i) => (
                <div key={i} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
                  <span>
                    {item.productLabel} — qtd {item.quantity}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => removeItem(i)}>
                    Remover
                  </Button>
                </div>
              ))}
              <ProductPicker value={itemProduct} onChange={setItemProduct} showPrice={false} />
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  value={itemQuantity}
                  onChange={(e) => setItemQuantity(e.target.value)}
                  className="w-24"
                />
                <Button variant="outline" onClick={addItem} disabled={!itemProduct}>
                  Adicionar
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <Label>Observações (opcional)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Salvando...' : 'Solicitar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
