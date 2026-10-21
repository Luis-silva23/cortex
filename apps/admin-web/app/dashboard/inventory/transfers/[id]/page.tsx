'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { validateReceiveQuantities, validateSendQuantities } from '@/lib/transfers';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  IN_TRANSIT: 'Em trânsito',
  RECEIVED: 'Recebida',
  CANCELLED: 'Cancelada',
};
const STATUS_VARIANT: Record<string, 'warning' | 'default' | 'success' | 'error'> = {
  PENDING: 'warning',
  IN_TRANSIT: 'default',
  RECEIVED: 'success',
  CANCELLED: 'error',
};

export default function TransferDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [transfer, setTransfer] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Quantidade a enviar/receber por item — pré-preenchida com o
  // solicitado/enviado ao carregar, editável (divergência é suportada de
  // propósito: recebido pode ser menor que enviado, nunca maior).
  const [sendQuantities, setSendQuantities] = useState<Record<string, string>>({});
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  // Erro por item (id do item -> mensagem): uma quantidade inválida derruba a
  // operação inteira na API (400), então apontamos qual linha está errada.
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [receiveErrors, setReceiveErrors] = useState<Record<string, string>>({});

  // Aprovar, rejeitar e cancelar exigem Gerente+ (a API responde 403 para os
  // demais) — a tela só oferece essas ações a quem pode; a API segue sendo a
  // autoridade.
  const { userType, ready: roleReady } = useUserType();
  const canDecide = isManagerOrAbove(userType);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getTransfer(id);
      setTransfer(result);
      const sendQ: Record<string, string> = {};
      const recvQ: Record<string, string> = {};
      for (const item of result.items ?? []) {
        sendQ[item.id] = String(item.requestedQuantity);
        recvQ[item.id] = String(item.sentQuantity ?? 0);
      }
      setSendQuantities(sendQ);
      setReceiveQuantities(recvQ);
      setSendErrors({});
      setReceiveErrors({});
    } catch (err) {
      console.error('Erro ao carregar transferência:', err);
      setError('Não foi possível carregar a transferência.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function approve() {
    setActionError(null);
    setBusy(true);
    try {
      await api.approveTransfer(id);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao aprovar'));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    const reason = window.prompt('Motivo da rejeição:');
    if (!reason) return;
    setActionError(null);
    setBusy(true);
    try {
      await api.rejectTransfer(id, reason);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao rejeitar'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const reason = window.prompt('Motivo do cancelamento:');
    if (!reason) return;
    setActionError(null);
    setBusy(true);
    try {
      await api.cancelTransfer(id, reason);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao cancelar'));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setActionError(null);
    // Valida no cliente ANTES de chamar a API: campo limpo virava 0 e a API
    // recusava a transferência inteira sem dizer qual item estava errado.
    const check = validateSendQuantities(
      (transfer.items ?? []).map((item: any) => ({
        id: item.id,
        label: item.product?.name ?? item.productId,
        max: Number(item.requestedQuantity),
      })),
      sendQuantities
    );
    setSendErrors(check.errors);
    if (!check.ok) {
      setActionError(check.message);
      return;
    }
    setBusy(true);
    try {
      const items = (transfer.items ?? []).map((item: any) => ({
        transferItemId: item.id,
        sentQuantity: Number(sendQuantities[item.id]),
      }));
      await api.sendTransfer(id, items);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao enviar'));
    } finally {
      setBusy(false);
    }
  }

  async function receive() {
    setActionError(null);
    const check = validateReceiveQuantities(
      (transfer.items ?? []).map((item: any) => ({
        id: item.id,
        label: item.product?.name ?? item.productId,
        max: Number(item.sentQuantity ?? 0),
      })),
      receiveQuantities
    );
    setReceiveErrors(check.errors);
    if (!check.ok) {
      setActionError(check.message);
      return;
    }
    setBusy(true);
    try {
      const items = (transfer.items ?? []).map((item: any) => ({
        transferItemId: item.id,
        receivedQuantity: Number(receiveQuantities[item.id]),
      }));
      await api.receiveTransfer(id, items);
      await load();
    } catch (err: any) {
      setActionError(getApiErrorMessage(err, 'Erro ao confirmar recebimento'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="p-12 text-center text-gray-500">Carregando...</div>;
  if (error || !transfer)
    return (
      <div className="p-12 text-center">
        <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
        <p className="text-gray-500 mb-4">{error || 'Transferência não encontrada.'}</p>
        <Link href="/dashboard/inventory">
          <Button variant="outline">Voltar</Button>
        </Link>
      </div>
    );

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
            <h1 className="text-3xl font-bold text-gray-900">Transferência #{transfer.transferNumber}</h1>
            <Badge variant={STATUS_VARIANT[transfer.status] ?? 'secondary'}>{STATUS_LABEL[transfer.status] ?? transfer.status}</Badge>
          </div>
          <p className="text-gray-500 mt-1">Solicitada em {new Date(transfer.requestedAt).toLocaleString('pt-BR')}</p>
        </div>
      </div>

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>
      )}

      {transfer.status === 'PENDING' && !transfer.approvedBy && canDecide && (
        <div className="flex gap-2">
          <Button onClick={approve} disabled={busy}>
            Aprovar
          </Button>
          <Button variant="outline" onClick={reject} disabled={busy}>
            Rejeitar
          </Button>
          <Button variant="outline" onClick={cancel} disabled={busy}>
            Cancelar
          </Button>
        </div>
      )}

      {transfer.status === 'PENDING' && !transfer.approvedBy && roleReady && !canDecide && (
        <Alert>
          <AlertDescription>
            {MANAGER_ONLY_NOTICE} Aprovar, rejeitar e cancelar transferências é decisão de Gerente ou Administrador.
          </AlertDescription>
        </Alert>
      )}

      {transfer.status === 'PENDING' && transfer.approvedBy && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Aprovada — pronta para envio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-500">Confira/ajuste a quantidade realmente enviada por item antes de confirmar a saída.</p>
            {(transfer.items ?? []).map((item: any) => (
              <div
                key={item.id}
                className={`rounded border px-3 py-2 ${sendErrors[item.id] ? 'border-danger' : 'border-border'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">
                    {item.product?.name ?? item.productId} — solicitado: {item.requestedQuantity}
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={Number(item.requestedQuantity)}
                    className="w-28"
                    aria-invalid={sendErrors[item.id] ? true : undefined}
                    value={sendQuantities[item.id] ?? ''}
                    onChange={(e) => {
                      setSendQuantities({ ...sendQuantities, [item.id]: e.target.value });
                      // Limpa o erro da linha assim que o usuário volta a editá-la.
                      if (sendErrors[item.id]) setSendErrors({ ...sendErrors, [item.id]: '' });
                    }}
                  />
                </div>
                {sendErrors[item.id] && (
                  <p className="mt-1 text-xs text-danger" role="alert">
                    {sendErrors[item.id]}
                  </p>
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <Button onClick={send} disabled={busy}>
                Confirmar envio
              </Button>
              {canDecide && (
                <Button variant="outline" onClick={cancel} disabled={busy}>
                  Cancelar
                </Button>
              )}
            </div>
            {roleReady && !canDecide && (
              <p className="text-xs text-muted-foreground">
                Somente Gerente ou Administrador pode cancelar uma transferência aprovada.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {transfer.status === 'IN_TRANSIT' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Em trânsito — confirmar recebimento</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-500">
              Recebido pode ser menor que enviado (perda/avaria no transporte) — a diferença fica registrada, nunca escondida.
            </p>
            {(transfer.items ?? []).map((item: any) => (
              <div
                key={item.id}
                className={`rounded border px-3 py-2 ${receiveErrors[item.id] ? 'border-danger' : 'border-border'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">
                    {item.product?.name ?? item.productId} — enviado: {item.sentQuantity ?? 0}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={Number(item.sentQuantity ?? 0)}
                    className="w-28"
                    aria-invalid={receiveErrors[item.id] ? true : undefined}
                    value={receiveQuantities[item.id] ?? ''}
                    onChange={(e) => {
                      setReceiveQuantities({ ...receiveQuantities, [item.id]: e.target.value });
                      if (receiveErrors[item.id]) setReceiveErrors({ ...receiveErrors, [item.id]: '' });
                    }}
                  />
                </div>
                {receiveErrors[item.id] && (
                  <p className="mt-1 text-xs text-danger" role="alert">
                    {receiveErrors[item.id]}
                  </p>
                )}
              </div>
            ))}
            <Button onClick={receive} disabled={busy}>
              Confirmar recebimento
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Itens</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead>Solicitado</TableHead>
                <TableHead>Enviado</TableHead>
                <TableHead>Recebido</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(transfer.items ?? []).map((item: any) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.product?.name ?? item.productId}</TableCell>
                  <TableCell>{item.requestedQuantity}</TableCell>
                  <TableCell>{item.sentQuantity ?? '-'}</TableCell>
                  <TableCell>{item.receivedQuantity ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {transfer.notes && (
        <Card>
          <CardContent className="p-4 text-sm text-gray-600">{transfer.notes}</CardContent>
        </Card>
      )}
    </div>
  );
}
