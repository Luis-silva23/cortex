'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Circle, Info, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/errors';
import { supplierReturnsApi, SupplierReturnDetail } from '@/lib/api/supplier-returns';
import {
  ACTION_LABEL,
  buildClosePayload,
  CloseForm,
  EVENT_LABEL,
  FLOW_STEPS,
  flowStepIndex,
  NOT_WARRANTY_NOTICE,
  OUTCOME_LABEL,
  REASON_LABEL,
  STATUS_LABEL,
  STATUS_VARIANT,
  SupplierReturnAction,
  SupplierReturnOutcome,
  validateReason,
  visibleActions,
} from '@/lib/supplier-returns';

const OUTCOMES = Object.keys(OUTCOME_LABEL) as SupplierReturnOutcome[];
const MOVEMENT_LABEL: Record<string, string> = {
  SUPPLIER_RETURN: 'Saída (devolução ao fornecedor)',
  RETURN: 'Entrada (estorno do cancelamento)',
  PURCHASE: 'Entrada (reposição do fornecedor)',
};
const dateTime = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('pt-BR') : '-');
const qty = (n: string | number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(Number(n));
const EMPTY_CLOSE: CloseForm = { outcome: '', outcomeAmount: '', outcomeNotes: '', received: {} };

export default function SupplierReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [ret, setRet] = useState<SupplierReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [action, setAction] = useState<SupplierReturnAction | null>(null);
  const [text, setText] = useState('');
  const [closeForm, setCloseForm] = useState<CloseForm>(EMPTY_CLOSE);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRet(await supplierReturnsApi.get(id));
    } catch (err) {
      setLoadError(getApiErrorMessage(err, 'Não foi possível carregar a devolução.'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const open = (a: SupplierReturnAction) => {
    setAction(a);
    setText('');
    setCloseForm(EMPTY_CLOSE);
    setActionError(null);
  };

  const confirm = async () => {
    if (!ret || !action) return;
    setActionError(null);
    try {
      let updated: SupplierReturnDetail;
      if (action === 'reject' || action === 'cancel') {
        const invalid = validateReason(text);
        if (invalid) {
          setActionError(invalid);
          return;
        }
        setBusy(true);
        updated = action === 'reject' ? await supplierReturnsApi.reject(ret.id, text.trim()) : await supplierReturnsApi.cancel(ret.id, text.trim());
      } else if (action === 'close') {
        const built = buildClosePayload(
          closeForm,
          ret.items.map((i) => ({ productId: i.productId, quantity: Number(i.quantity), label: i.product.name }))
        );
        if (!built.ok) {
          setActionError(built.error);
          return;
        }
        setBusy(true);
        updated = await supplierReturnsApi.close(ret.id, built.payload);
      } else {
        setBusy(true);
        updated =
          action === 'approve'
            ? await supplierReturnsApi.approve(ret.id, text.trim() || undefined)
            : await supplierReturnsApi.send(ret.id, text.trim() || undefined);
      }
      setRet(updated);
      setAction(null);
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Não foi possível concluir a ação.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="p-12 text-center text-muted-foreground">Carregando...</div>;
  if (loadError || !ret) {
    return (
      <div className="space-y-4 p-6">
        <p role="alert" className="text-danger">
          {loadError ?? 'Devolução não encontrada.'}
        </p>
        <Link href="/dashboard/purchases/returns">
          <Button variant="outline">Voltar para a lista</Button>
        </Link>
      </div>
    );
  }

  const actions = visibleActions(ret.allowedActions);
  const step = flowStepIndex(ret.status);
  const interrupted = step === -1;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/purchases/returns">
            <Button variant="ghost" size="icon" aria-label="Voltar">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold text-foreground">Devolução #{ret.returnNumber}</h1>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant={STATUS_VARIANT[ret.status] ?? 'secondary'}>{STATUS_LABEL[ret.status] ?? ret.status}</Badge>
              <span className="text-sm text-muted-foreground">{ret.supplier?.name}</span>
            </div>
          </div>
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Button key={a} variant={a === 'reject' || a === 'cancel' ? 'outline' : 'default'} onClick={() => open(a)}>
                {ACTION_LABEL[a]}
              </Button>
            ))}
          </div>
        )}
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>{NOT_WARRANTY_NOTICE}</AlertDescription>
      </Alert>

      <Card>
        <CardContent className="pt-6">
          <ol className="grid gap-3 sm:grid-cols-4" aria-label="Etapas da devolução">
            {FLOW_STEPS.map((s, i) => {
              const done = !interrupted && i <= step;
              return (
                <li key={s.status} className="flex items-center gap-2 text-sm">
                  {done ? <CheckCircle2 className="h-4 w-4 text-foreground" aria-hidden /> : <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />}
                  <span className={done ? 'font-medium text-foreground' : 'text-muted-foreground'}>{s.label}</span>
                </li>
              );
            })}
          </ol>
          {interrupted && (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <XCircle className="h-4 w-4 text-danger" aria-hidden />
              Fluxo encerrado: {STATUS_LABEL[ret.status].toLowerCase()}.
              {ret.decisionNotes && ret.status === 'REJECTED' ? ` Motivo: ${ret.decisionNotes}` : ''}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Dados da devolução</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Fornecedor</dt>
              <dd className="text-foreground">{ret.supplier?.name}</dd>
              <dt className="text-muted-foreground">Motivo</dt>
              <dd className="text-foreground">{REASON_LABEL[ret.reason] ?? ret.reason}</dd>
              {ret.description && (
                <>
                  <dt className="text-muted-foreground">Descrição</dt>
                  <dd className="whitespace-pre-wrap text-foreground">{ret.description}</dd>
                </>
              )}
              {ret.purchaseOrder && (
                <>
                  <dt className="text-muted-foreground">Pedido de compra</dt>
                  <dd>
                    <Link className="text-foreground underline" href={`/dashboard/purchases/${ret.purchaseOrder.id}`}>
                      #{ret.purchaseOrder.poNumber}
                    </Link>
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Solicitada por</dt>
              <dd className="text-foreground">
                {ret.requestedByName ?? 'Usuário'} · {dateTime(ret.createdAt)}
              </dd>
              {ret.approvedBy && (
                <>
                  <dt className="text-muted-foreground">Aprovada por</dt>
                  <dd className="text-foreground">
                    {ret.approvedByName ?? 'Usuário'} · {dateTime(ret.approvedAt)}
                  </dd>
                </>
              )}
              {ret.stockWithdrawnAt && (
                <>
                  <dt className="text-muted-foreground">Estoque retirado em</dt>
                  <dd className="text-foreground">{dateTime(ret.stockWithdrawnAt)}</dd>
                </>
              )}
              {ret.sentAt && (
                <>
                  <dt className="text-muted-foreground">Enviada</dt>
                  <dd className="text-foreground">
                    {ret.sentByName ?? 'Usuário'} · {dateTime(ret.sentAt)}
                    {ret.shippingInfo ? ` · ${ret.shippingInfo}` : ''}
                  </dd>
                </>
              )}
              {ret.outcome && (
                <>
                  <dt className="text-muted-foreground">Resultado</dt>
                  <dd className="text-foreground">
                    {OUTCOME_LABEL[ret.outcome] ?? ret.outcome}
                    {ret.outcomeAmount !== null && ret.outcomeAmount !== undefined ? ` · ${formatCurrency(Number(ret.outcomeAmount))}` : ''}
                    {ret.outcomeNotes ? ` · ${ret.outcomeNotes}` : ''}
                  </dd>
                </>
              )}
            </dl>
            {ret.outcome && (
              <p className="mt-4 text-xs text-muted-foreground">
                O resultado é só registrado: crédito/reembolso não gera conta a pagar/receber nem documento fiscal automaticamente.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Histórico</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {ret.events.map((e) => (
                <li key={e.id} className="border-l-2 border-border pl-3 text-sm">
                  <p className="font-medium text-foreground">{EVENT_LABEL[e.type] ?? e.type}</p>
                  <p className="text-xs text-muted-foreground">
                    {e.userName ?? 'Usuário'} · {dateTime(e.createdAt)}
                  </p>
                  {e.notes && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{e.notes}</p>}
                </li>
              ))}
            </ol>
          </CardContent>
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
              <TableHead className="text-right">Quantidade</TableHead>
              <TableHead className="text-right">Custo unit.</TableHead>
              <TableHead>Observação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ret.items.map((i) => (
              <TableRow key={i.id}>
                <TableCell>
                  {i.product.name} <span className="text-xs text-muted-foreground">({i.product.sku})</span>
                  {i.damageRecordId && <span className="block text-xs text-muted-foreground">Ligado a avaria: já saiu do estoque pela avaria</span>}
                </TableCell>
                <TableCell className="text-right">{qty(i.quantity)}</TableCell>
                <TableCell className="text-right">{i.unitCost !== null ? formatCurrency(Number(i.unitCost)) : '-'}</TableCell>
                <TableCell>{i.notes ?? '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {ret.stockMovements.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Movimentos de estoque desta devolução</CardTitle>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Produto</TableHead>
                <TableHead className="text-right">Quantidade</TableHead>
                <TableHead>Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ret.stockMovements.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{MOVEMENT_LABEL[m.movementType] ?? m.movementType}</TableCell>
                  <TableCell>{ret.items.find((i) => i.productId === m.productId)?.product.name ?? '-'}</TableCell>
                  <TableCell className="text-right">{qty(m.quantity)}</TableCell>
                  <TableCell>{dateTime(m.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={action !== null} onOpenChange={(o) => !o && !busy && setAction(null)}>
        <DialogContent onClose={() => !busy && setAction(null)}>
          <DialogHeader>
            <DialogTitle>{action ? ACTION_LABEL[action] : ''}</DialogTitle>
            <DialogDescription>
              {action === 'approve' && 'Ao aprovar, os itens saem do estoque desta filial agora. Se o saldo não for suficiente, a aprovação é recusada.'}
              {action === 'reject' && 'A devolução é recusada e o estoque não é alterado. Informe o motivo.'}
              {action === 'send' && 'Registre que a mercadoria foi enviada ao fornecedor (transporte, rastreio, documento).'}
              {action === 'close' && 'Registre o resultado informado pelo fornecedor. Crédito/reembolso fica só registrado (sem lançamento financeiro automático).'}
              {action === 'cancel' &&
                (ret.status === 'APPROVED'
                  ? 'A devolução já aprovada será cancelada e os itens voltam ao estoque. Informe o motivo.'
                  : 'A solicitação será cancelada. Informe o motivo.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-6">
            {action === 'close' ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="sr-outcome">Resultado *</Label>
                  <Select id="sr-outcome" value={closeForm.outcome} onChange={(e) => setCloseForm({ ...closeForm, outcome: e.target.value as SupplierReturnOutcome | '' })}>
                    <option value="">Selecione</option>
                    {OUTCOMES.map((o) => (
                      <option key={o} value={o}>
                        {OUTCOME_LABEL[o]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sr-amount">Valor (R$, opcional)</Label>
                  <Input id="sr-amount" inputMode="decimal" value={closeForm.outcomeAmount} onChange={(e) => setCloseForm({ ...closeForm, outcomeAmount: e.target.value })} />
                </div>
                {closeForm.outcome === 'REPLACEMENT' && (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-foreground">Reposição recebida (deixe vazio o que ainda não chegou)</legend>
                    {ret.items.map((i) => (
                      <div key={i.id} className="flex items-center gap-3">
                        <Label htmlFor={`rcv-${i.id}`} className="flex-1 text-sm">
                          {i.product.name} <span className="text-muted-foreground">(devolvido: {qty(i.quantity)})</span>
                        </Label>
                        <Input
                          id={`rcv-${i.id}`}
                          className="w-28"
                          inputMode="decimal"
                          value={closeForm.received[i.productId] ?? ''}
                          onChange={(e) => setCloseForm({ ...closeForm, received: { ...closeForm.received, [i.productId]: e.target.value } })}
                        />
                      </div>
                    ))}
                  </fieldset>
                )}
                <div className="space-y-2">
                  <Label htmlFor="sr-outcome-notes">Observação</Label>
                  <Textarea id="sr-outcome-notes" rows={3} maxLength={2000} value={closeForm.outcomeNotes} onChange={(e) => setCloseForm({ ...closeForm, outcomeNotes: e.target.value })} />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="sr-text">
                  {action === 'reject' || action === 'cancel' ? 'Motivo *' : action === 'send' ? 'Informações do envio (opcional)' : 'Observação (opcional)'}
                </Label>
                <Textarea id="sr-text" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
              </div>
            )}
            {actionError && (
              <p role="alert" className="text-sm text-danger">
                {actionError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
              Voltar
            </Button>
            <Button variant={action === 'reject' || action === 'cancel' ? 'destructive' : 'default'} disabled={busy} onClick={confirm}>
              {busy ? 'Enviando...' : action ? ACTION_LABEL[action] : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
