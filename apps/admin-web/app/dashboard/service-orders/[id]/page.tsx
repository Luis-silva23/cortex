'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Plus, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ReportProblemButton } from '@/components/support/ReportProblemButton';
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
import { api, getCurrentUserClaims } from '@/lib/api';
import { useUserType } from '@/lib/hooks/useUserType';
import { getApiErrorMessage } from '@/lib/errors';
import { buildAddItemPayload, canAddServiceOrderItem, parseDecimal, pickMechanics } from '@/lib/service-orders';
import { collectAllPages } from '@/lib/list-pagination';
import { ProductPicker, type ProductOption } from '@/components/service-orders/ProductPicker';
import { CloseServiceOrderDialog } from '@/components/service-orders/CloseServiceOrderDialog';
import { WarrantyCard } from '@/components/service-orders/WarrantyCard';
import { ServiceOrderDiscountPanel } from '@/components/service-orders/ServiceOrderDiscountPanel';

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

// Espelha ALLOWED_TRANSITIONS de service-order.service.ts — mantido aqui
// só para desenhar os botões certos; a validação de verdade é sempre no
// backend (o botão errado aqui só resultaria num 400, nunca numa transição
// indevida).
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  ENTRADA: ['DIAGNOSTICO', 'CANCELADA'],
  DIAGNOSTICO: ['ORCAMENTO', 'CANCELADA'],
  ORCAMENTO: ['APROVACAO', 'CANCELADA'],
  APROVACAO: ['EXECUCAO', 'CANCELADA'],
  EXECUCAO: ['PRONTO', 'CANCELADA'],
  PRONTO: ['ENTREGA', 'CANCELADA'],
  ENTREGA: ['ENCERRADA'],
  ENCERRADA: [],
  CANCELADA: [],
};

const PAYMENT_METHODS = ['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'PIX', 'BANK_TRANSFER'];
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Dinheiro',
  DEBIT_CARD: 'Cartão Débito',
  CREDIT_CARD: 'Cartão Crédito',
  PIX: 'PIX',
  BANK_TRANSFER: 'Transferência',
};

export default function ServiceOrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [os, setOs] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Papel lido depois de montar (o JWT só existe no navegador — sem hydration mismatch).
  const { userType } = useUserType();
  const [transitioning, setTransitioning] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);

  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [itemSaving, setItemSaving] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);
  const [itemType, setItemType] = useState<'SERVICE' | 'PART'>('SERVICE');
  // Produto escolhido na busca do catálogo (a busca é no servidor — não existe
  // mais uma lista fixa de produtos carregada em memória).
  const [itemProduct, setItemProduct] = useState<ProductOption | null>(null);
  const [itemDescription, setItemDescription] = useState('');
  const [itemQuantity, setItemQuantity] = useState('1');
  const [itemUnitPrice, setItemUnitPrice] = useState('0');

  const [mechanics, setMechanics] = useState<Array<{ id: string; name: string }>>([]);
  const [mechanicsLoading, setMechanicsLoading] = useState(false);
  const [mechanicDialogOpen, setMechanicDialogOpen] = useState(false);
  const [selectedMechanicId, setSelectedMechanicId] = useState('');
  const [mechanicSaving, setMechanicSaving] = useState(false);
  const [mechanicError, setMechanicError] = useState<string | null>(null);

  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [paymentSaving, setPaymentSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getServiceOrder(id);
      setOs(result);
    } catch (err) {
      console.error('Erro ao carregar OS:', err);
      setError('Não foi possível carregar a ordem de serviço.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function transition(toStatus: string) {
    setActionError(null);
    if (toStatus === 'ENCERRADA' && !os.isPaid) {
      setPaymentDialogOpen(true);
      return;
    }
    // Encerramento pede a decisão de garantia (sem/com garantia) — diálogo próprio, mesma transação na API.
    if (toStatus === 'ENCERRADA') {
      setCloseDialogOpen(true);
      return;
    }
    if (toStatus === 'CANCELADA' && !window.confirm('Cancelar esta OS? Essa ação não pode ser desfeita.')) {
      return;
    }
    setTransitioning(true);
    try {
      await api.transitionServiceOrderStatus(id, toStatus);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao mudar status'));
    } finally {
      setTransitioning(false);
    }
  }

  function openItemDialog() {
    setItemType('SERVICE');
    setItemProduct(null);
    setItemDescription('');
    setItemQuantity('1');
    setItemUnitPrice('0');
    setItemError(null);
    setItemDialogOpen(true);
  }

  function pickProduct(product: ProductOption | null) {
    setItemProduct(product);
    // Ajuda a preencher: se a descrição ainda está vazia, usa o nome do produto.
    if (product && !itemDescription.trim()) setItemDescription(product.name);
  }

  async function saveItem() {
    setItemError(null);
    const built = buildAddItemPayload({
      itemType,
      product: itemType === 'PART' ? itemProduct : null,
      description: itemDescription,
      quantity: itemQuantity,
      unitPrice: itemUnitPrice,
    });
    if (!built.ok) {
      setItemError(built.error);
      return;
    }
    setItemSaving(true);
    try {
      await api.addServiceOrderItem(id, built.payload);
      setItemDialogOpen(false);
      await load();
    } catch (err: any) {
      setItemError(getApiErrorMessage(err, 'Erro ao adicionar item'));
    } finally {
      setItemSaving(false);
    }
  }

  // O servidor já filtra por perfil e situação (GET /users?userType&isActive);
  // pickMechanics fica como segunda barreira e para ordenar por nome (o
  // backend recusa qualquer outro perfil como mecânico da OS).
  async function fetchMechanics() {
    const collected = await collectAllPages<any>((page) =>
      api.getUsers({ userType: 'MECHANIC', isActive: true, page, limit: 100 })
    );
    return pickMechanics(collected);
  }

  function openMechanicDialog() {
    setSelectedMechanicId(os?.mechanicId ?? '');
    setMechanicError(null);
    setMechanicDialogOpen(true);
    if (mechanics.length === 0) {
      setMechanicsLoading(true);
      fetchMechanics()
        .then(setMechanics)
        .catch((err) => {
          setMechanics([]);
          setMechanicError(getApiErrorMessage(err, 'Não foi possível carregar a lista de mecânicos.'));
        })
        .finally(() => setMechanicsLoading(false));
    }
  }

  async function saveMechanic() {
    if (!selectedMechanicId) return;
    setMechanicError(null);
    setMechanicSaving(true);
    try {
      await api.assignServiceOrderMechanic(id, selectedMechanicId);
      setMechanicDialogOpen(false);
      await load();
    } catch (err) {
      setMechanicError(getApiErrorMessage(err, 'Erro ao atribuir mecânico'));
    } finally {
      setMechanicSaving(false);
    }
  }

  // MECHANIC só assume a OS para si (e só se ainda está sem mecânico): o backend
  // recusa reatribuir, porque a comissão vai para o mecânico vigente no pagamento.
  async function assumeOrder() {
    const myId = getCurrentUserClaims()?.userId;
    if (!myId) return;
    setActionError(null);
    setMechanicSaving(true);
    try {
      await api.assignServiceOrderMechanic(id, myId);
      await load();
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Não foi possível assumir esta OS'));
    } finally {
      setMechanicSaving(false);
    }
  }

  async function submitPayment() {
    setPaymentSaving(true);
    try {
      await api.registerServiceOrderPayment(id, paymentMethod);
      setPaymentDialogOpen(false);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao registrar pagamento'));
      setPaymentDialogOpen(false);
    } finally {
      setPaymentSaving(false);
    }
  }

  if (loading) return <div className="p-12 text-center text-gray-500">Carregando...</div>;
  if (error || !os)
    return (
      <div className="p-12 text-center">
        <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
        <p className="text-gray-500 mb-4">{error || 'Ordem de serviço não encontrada.'}</p>
        <Link href="/dashboard/service-orders">
          <Button variant="outline">Voltar</Button>
        </Link>
      </div>
    );

  const allowedNext = ALLOWED_TRANSITIONS[os.status] ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/service-orders">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-gray-900">OS #{os.osNumber}</h1>
            <Badge variant={STATUS_VARIANT[os.status] ?? 'secondary'}>{STATUS_LABEL[os.status] ?? os.status}</Badge>
            {os.isPaid && <Badge variant="success">Pago</Badge>}
            <ReportProblemButton context={{ module: 'OFICINA', screen: `Oficina → OS #${os.osNumber}`, entityType: 'SERVICE_ORDER', entityId: os.id }} />
          </div>
          <p className="text-gray-500 mt-1">
            {os.customer?.name} — {os.motorcycle ? `${os.motorcycle.brand} ${os.motorcycle.model}` : ''}
          </p>
        </div>
      </div>

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>
      )}

      {allowedNext.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {allowedNext.map((next) => (
            <Button
              key={next}
              variant={next === 'CANCELADA' ? 'outline' : 'default'}
              disabled={transitioning}
              onClick={() => transition(next)}
            >
              {next === 'CANCELADA' ? 'Cancelar OS' : `Avançar para ${STATUS_LABEL[next]}`}
            </Button>
          ))}
          {userType === 'MECHANIC' ? (
            os.mechanic ? (
              <Button variant="outline" disabled>
                {`Mecânico: ${os.mechanic.name}`}
              </Button>
            ) : (
              <Button variant="outline" onClick={assumeOrder} disabled={mechanicSaving}>
                {mechanicSaving ? 'Assumindo...' : 'Assumir esta OS'}
              </Button>
            )
          ) : (
            <Button variant="outline" onClick={openMechanicDialog}>
              {os.mechanic ? `Mecânico: ${os.mechanic.name}` : 'Atribuir mecânico'}
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-gray-500">Mão de obra</p>
            <p className="text-xl font-semibold">{formatCurrency(Number(os.laborTotal))}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-gray-500">Peças</p>
            <p className="text-xl font-semibold">{formatCurrency(Number(os.partsTotal))}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-gray-500">Total</p>
            <p className="text-xl font-semibold">{formatCurrency(Number(os.finalTotal))}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">Itens (peças e serviços)</CardTitle>
          {canAddServiceOrderItem(os) ? (
            <Button size="sm" onClick={openItemDialog}>
              <Plus className="h-4 w-4 mr-2" />
              Adicionar item
            </Button>
          ) : (
            // OS paga: o backend recusa item novo (o pagamento congela o valor
            // cobrado e a comissão) — em vez de um botão que só daria erro,
            // explica por que não dá para adicionar.
            os.isPaid &&
            os.status !== 'ENCERRADA' &&
            os.status !== 'CANCELADA' && (
              <p className="text-xs text-muted-foreground">OS já paga — não é possível adicionar itens.</p>
            )
          )}
        </CardHeader>
        <CardContent>
          {os.items?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Qtd</TableHead>
                  <TableHead>Preço unit.</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {os.items.map((item: any) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.itemType === 'PART' ? 'Peça' : 'Serviço'}</TableCell>
                    <TableCell>{item.description}</TableCell>
                    <TableCell>{item.quantity}</TableCell>
                    <TableCell>{formatCurrency(Number(item.unitPrice))}</TableCell>
                    <TableCell>{formatCurrency(Number(item.totalPrice))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-gray-500 py-6 text-center">Nenhum item adicionado ainda.</p>
          )}
        </CardContent>
      </Card>

      {/* Desconto por tipo (política de desconto — docs/CORTEX/policies/DESCONTO.md); MECHANIC não concede desconto */}
      {userType !== 'MECHANIC' && (
        <ServiceOrderDiscountPanel key={`${os.id}-${os.laborTotal}-${os.partsTotal}-${os.isPaid}`} serviceOrderId={os.id} onChanged={load} />
      )}

      <WarrantyCard os={os} />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Histórico</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {os.statusHistory?.map((h: any) => (
              <li key={h.id} className="text-sm text-gray-600 flex justify-between border-b pb-2">
                <span>
                  {h.fromStatus ? `${STATUS_LABEL[h.fromStatus] ?? h.fromStatus} → ` : ''}
                  {STATUS_LABEL[h.toStatus] ?? h.toStatus}
                  {h.notes ? ` — ${h.notes}` : ''}
                </span>
                <span className="text-gray-400">{new Date(h.changedAt).toLocaleString('pt-BR')}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar Item</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {itemError && <p className="text-sm text-danger">{itemError}</p>}
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Select value={itemType} onChange={(e) => { setItemType(e.target.value as any); setItemProduct(null); }}>
                <option value="SERVICE">Serviço (mão de obra)</option>
                <option value="PART">Peça</option>
              </Select>
            </div>
            {itemType === 'PART' && (
              <div className="space-y-1">
                <Label>Produto do catálogo (opcional — sem escolher, vira peça avulsa)</Label>
                <ProductPicker value={itemProduct} onChange={pickProduct} placeholder="Buscar peça por nome ou SKU" />
                {itemProduct && (
                  <p className="text-xs text-muted-foreground">
                    O preço sempre vem do catálogo para peças cadastradas — não é possível alterar aqui.
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1">
              <Label>Descrição</Label>
              <Input value={itemDescription} onChange={(e) => setItemDescription(e.target.value)} placeholder={itemType === 'SERVICE' ? 'Ex: Troca de óleo' : 'Ex: Filtro de óleo'} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Quantidade</Label>
                <Input type="number" min={1} value={itemQuantity} onChange={(e) => setItemQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Preço unitário</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={itemType === 'PART' && itemProduct ? parseDecimal(itemProduct.salePrice) : itemUnitPrice}
                  onChange={(e) => setItemUnitPrice(e.target.value)}
                  disabled={itemType === 'PART' && !!itemProduct}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setItemDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveItem} disabled={itemSaving}>
              {itemSaving ? 'Salvando...' : 'Adicionar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mechanicDialogOpen} onOpenChange={setMechanicDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Atribuir mecânico</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {mechanicError && <p className="text-sm text-danger">{mechanicError}</p>}
            {mechanicsLoading ? (
              <p className="text-sm text-muted-foreground">Carregando mecânicos...</p>
            ) : (
              <>
                <Select value={selectedMechanicId} onChange={(e) => setSelectedMechanicId(e.target.value)}>
                  <option value="">Selecione...</option>
                  {mechanics.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
                {mechanics.length === 0 && !mechanicError && (
                  <p className="text-xs text-muted-foreground">
                    Nenhum mecânico ativo encontrado. Cadastre um usuário com o perfil Mecânico em Configurações &gt;
                    Usuários.
                  </p>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMechanicDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveMechanic} disabled={!selectedMechanicId || mechanicSaving}>
              {mechanicSaving ? 'Atribuindo...' : 'Atribuir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CloseServiceOrderDialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen} os={os} onClosed={load} />

      <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar pagamento para encerrar</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Encerrar financeiramente exige pagamento confirmado — sem isso, a OS não pode ir para ENCERRADA.
            </p>
            <div className="space-y-1">
              <Label>Forma de pagamento</Label>
              <Select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={submitPayment} disabled={paymentSaving}>
              {paymentSaving ? 'Registrando...' : 'Registrar pagamento'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
