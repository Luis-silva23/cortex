'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Scale, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/errors';
import {
  reconciliationApi,
  IntegrationInconsistency,
  INCONSISTENCY_TYPE_LABEL,
  RESOLUTION_LABEL,
  SALE_STATUS_LABEL,
} from '@/lib/api/reconciliation';

/**
 * Financeiro › Conciliação — inconsistências de integração de pagamento (docs/CORTEX/policies/CAIXA.md e
 * BUSINESS_RULES "venda cancelada e pagamento"). Ex.: o provedor aprovou o pagamento depois que a venda foi cancelada.
 * A venda NÃO é reaberta nem vira paga e o sistema não cria crédito, venda nem estorno por conta própria: quem pode
 * estornar escolhe estornar no provedor ou registrar o tratamento feito fora do sistema, com justificativa.
 */
type Filter = 'open' | 'all';
const NOTE_MIN = 10;

export default function ReconciliationPage() {
  const [filter, setFilter] = useState<Filter>('open');
  const [rows, setRows] = useState<IntegrationInconsistency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<IntegrationInconsistency | null>(null);
  const [mode, setAction] = useState<'view' | 'MANUAL' | 'REFUND'>('view');
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await reconciliationApi.list(filter === 'open'));
      setError('');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar as inconsistências'));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  function openDetail(row: IntegrationInconsistency) {
    setSelected(row);
    setAction('view');
    setNote('');
    setActionError('');
  }

  async function resolve() {
    if (!selected || mode === 'view') return;
    if (mode === 'MANUAL' && note.trim().length < NOTE_MIN) {
      setActionError(`Descreva como foi tratado (mínimo ${NOTE_MIN} caracteres)`);
      return;
    }
    setSaving(true);
    setActionError('');
    try {
      await reconciliationApi.resolve(selected.id, { action: mode, ...(mode === 'MANUAL' ? { note: note.trim() } : {}) });
      setSelected(null);
      await load();
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Não foi possível tratar a inconsistência'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold text-foreground">
            <Scale className="h-7 w-7" aria-hidden /> Conciliação
          </h1>
          <p className="mt-1 text-muted-foreground">
            Inconsistências de integração: o provedor de pagamento informou algo que não bate com a venda (ex.: aprovou depois do
            cancelamento). A venda não é reaberta e nada é lançado sozinho.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={filter === 'open' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('open')}>
            Abertas
          </Button>
          <Button variant={filter === 'all' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('all')}>
            Abertas e tratadas
          </Button>
          <Button variant="outline" size="sm" onClick={load} aria-label="Atualizar">
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{filter === 'open' ? 'Inconsistências abertas' : 'Todas as inconsistências'}</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Carregando...</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground" data-testid="reconciliation-empty">
              {filter === 'open' ? 'Nenhuma inconsistência aberta.' : 'Nenhuma inconsistência registrada.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Detectada em</TableHead>
                  <TableHead>Ocorrência</TableHead>
                  <TableHead>Venda</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Provedor</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{new Date(row.detectedAt).toLocaleString('pt-BR')}</TableCell>
                    <TableCell>{INCONSISTENCY_TYPE_LABEL[row.type] ?? row.type}</TableCell>
                    <TableCell>
                      <Link className="underline underline-offset-2" href={`/dashboard/sales/${row.saleId}`}>
                        {SALE_STATUS_LABEL[row.saleStatus] ?? row.saleStatus}
                      </Link>
                    </TableCell>
                    <TableCell>{formatCurrency(Number(row.amount))}</TableCell>
                    <TableCell>
                      {row.provider ?? '—'} ({row.providerStatus})
                    </TableCell>
                    <TableCell>
                      {row.resolvedAt ? (
                        <Badge variant="success">{RESOLUTION_LABEL[row.resolution ?? ''] ?? 'Tratada'}</Badge>
                      ) : (
                        <Badge variant="warning">Aberta</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => openDetail(row)}>
                        {row.resolvedAt ? 'Detalhe' : 'Tratar'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(v) => !v && !saving && setSelected(null)}>
        {selected && (
          <DialogContent onClose={() => !saving && setSelected(null)} className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Inconsistência de integração</DialogTitle>
              <DialogDescription>{INCONSISTENCY_TYPE_LABEL[selected.type] ?? selected.type}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 p-6 text-sm">
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Valor aprovado no provedor</dt>
                  <dd className="font-semibold">{formatCurrency(Number(selected.amount))}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Venda</dt>
                  <dd>{SALE_STATUS_LABEL[selected.saleStatus] ?? selected.saleStatus} (continua assim)</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Provedor / situação</dt>
                  <dd>
                    {selected.provider ?? '—'} / {selected.providerStatus}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Transação</dt>
                  <dd className="break-all">{selected.payment?.transactionId ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Detectada em</dt>
                  <dd>{new Date(selected.detectedAt).toLocaleString('pt-BR')}</dd>
                </div>
                {selected.resolvedAt && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Tratada em</dt>
                    <dd>
                      {new Date(selected.resolvedAt).toLocaleString('pt-BR')} — {RESOLUTION_LABEL[selected.resolution ?? ''] ?? selected.resolution}
                    </dd>
                  </div>
                )}
              </dl>
              {selected.notes && <p className="rounded-md border border-border p-2 text-muted-foreground">{selected.notes}</p>}

              {!selected.resolvedAt && (
                <div className="space-y-3 rounded-md border border-border p-3">
                  <p className="font-medium">Como tratar</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={mode === 'REFUND' ? 'default' : 'outline'} onClick={() => setAction('REFUND')} disabled={saving}>
                      Estornar no provedor
                    </Button>
                    <Button size="sm" variant={mode === 'MANUAL' ? 'default' : 'outline'} onClick={() => setAction('MANUAL')} disabled={saving}>
                      Registrar tratamento manual
                    </Button>
                  </div>
                  {mode === 'REFUND' && (
                    <p className="text-muted-foreground">
                      O estorno é pedido ao provedor. Só fica registrado como estornado com a confirmação dele; sem resposta, a inconsistência
                      continua aberta para nova tentativa.
                    </p>
                  )}
                  {mode === 'MANUAL' && (
                    <div className="space-y-1">
                      <Label htmlFor="reconciliation-note">Justificativa (o que foi feito fora do sistema)</Label>
                      <Textarea id="reconciliation-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} />
                      <p className="text-xs text-muted-foreground">Não movimenta dinheiro, não cria venda nem crédito: só registra o tratamento.</p>
                    </div>
                  )}
                </div>
              )}
              {actionError && (
                <p className="text-sm text-danger" role="alert">
                  {actionError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelected(null)} disabled={saving}>
                Fechar
              </Button>
              {!selected.resolvedAt && mode !== 'view' && (
                <Button onClick={resolve} disabled={saving}>
                  {saving ? 'Enviando...' : mode === 'REFUND' ? 'Confirmar estorno no provedor' : 'Registrar tratamento'}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
