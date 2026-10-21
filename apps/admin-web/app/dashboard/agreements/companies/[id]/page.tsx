'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Lock, Unlock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getApiErrorMessage } from '@/lib/errors';
import { isCompanyAdminOrAbove } from '@/lib/role-gates';
import { useUserType } from '@/lib/hooks/useUserType';
import { agreementsApi, brl, COMPANY_STATUS_LABEL, CompanyDetail } from '@/lib/api/agreements';

const RECEIVABLE_STATUS: Record<string, string> = { PENDING: 'Em aberto', OVERDUE: 'Vencida', PAID: 'Recebida', CANCELLED: 'Cancelada' };

export default function AgreementCompanyPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'block' | 'unblock' | null>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { userType } = useUserType();
  const canAuthorize = isCompanyAdminOrAbove(userType);

  const load = () =>
    agreementsApi
      .getCompany(params.id)
      .then(setData)
      .catch((e) => setError(getApiErrorMessage(e, 'Não foi possível carregar a empresa conveniada.')));
  useEffect(() => {
    load();
  }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    setActionError(null);
    setSaving(true);
    try {
      if (dialog === 'block') await agreementsApi.blockCompany(params.id, reason);
      else await agreementsApi.unblockCompany(params.id, reason);
      setDialog(null);
      setReason('');
      await load();
    } catch (e) {
      setActionError(getApiErrorMessage(e, 'Não foi possível concluir'));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Carregando...</p>;
  const f = data.financials;
  return (
    <div className="space-y-6">
      <Link href="/dashboard/agreements" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> Convênios
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {data.tradeName || data.legalName}{' '}
            <Badge variant={data.status === 'ACTIVE' ? 'success' : data.status === 'BLOCKED' ? 'error' : 'secondary'}>{COMPANY_STATUS_LABEL[data.status]}</Badge>
          </h1>
          <p className="text-muted-foreground">
            {data.legalName} · CNPJ {data.cnpj} · Prazo {data.paymentTermDays} dias ·{' '}
            {(data as any).allowedBranchIds?.length ? `${(data as any).allowedBranchIds.length} filial(is) liberada(s)` : 'todas as filiais'}
          </p>
          <p className="text-sm text-muted-foreground">
            Responsável {data.contactName ?? '—'} · WhatsApp {data.whatsapp ?? '—'} · Telefone {data.phone ?? '—'} · E-mail {data.email ?? '—'}
          </p>
          {data.status === 'BLOCKED' && (
            <p className="mt-1 text-sm text-danger">
              Bloqueada em {data.blockedAt ? new Date(data.blockedAt).toLocaleString('pt-BR') : '—'} por {data.blockedBy === 'SYSTEM' ? 'rotina automática' : 'gerência'}:{' '}
              {data.blockedReason}
            </p>
          )}
        </div>
        {data.status === 'ACTIVE' && (
          <Button variant="outline" onClick={() => setDialog('block')}>
            <Lock className="mr-2 h-4 w-4" /> Bloquear
          </Button>
        )}
        {data.status === 'BLOCKED' &&
          (canAuthorize ? (
            <Button variant="outline" onClick={() => setDialog('unblock')}>
              <Unlock className="mr-2 h-4 w-4" /> Desbloquear
            </Button>
          ) : (
            <p className="max-w-xs text-sm text-muted-foreground">Desbloquear (liberar crédito de novo) é da administração da empresa.</p>
          ))}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Utilizado (em aberto)" value={brl(f.openBalance)} hint={`${f.openCount} conta(s)`} />
        <Kpi label="Limite de crédito" value={brl(f.creditLimit)} />
        <Kpi label="Compras no mês" value={brl(f.monthUsed)} hint={`limite mensal ${brl(f.monthlyLimit)}`} />
        <Kpi label="Disponível" value={brl(f.available)} strong />
        <Kpi label="Vencido" value={brl(f.overdueAmount)} hint={f.overdueCount ? `${f.overdueCount} conta(s) · ${f.maxDaysOverdue} dias de atraso` : 'em dia'} danger={f.delinquent} />
      </div>
      <p className="text-sm text-muted-foreground">
        Bloqueio automático: {data.effectiveBlockAfterDaysOverdue == null ? 'desligado (só manual)' : `após ${data.effectiveBlockAfterDaysOverdue} dias de atraso`}
        {data.blockAfterDaysOverdue == null ? ' (política da empresa)' : ' (desta conveniada)'}. Multa {data.finePercent ?? '—'}% · juros {data.interestPercentMonthly ?? '—'}% a.m.
        (apenas informativo, não lançado na conta).
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Contas a receber do convênio</CardTitle>
        </CardHeader>
        <CardContent>
          {data.receivables.length === 0 ? (
            <p className="text-muted-foreground">Nenhuma conta.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Vencimento</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Atraso / juros e multa (info)</TableHead>
                  <TableHead>Cobrança</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.receivables.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.description}</TableCell>
                    <TableCell>{brl(r.amount)}</TableCell>
                    <TableCell>{new Date(r.dueDate).toLocaleDateString('pt-BR')}</TableCell>
                    <TableCell>
                      <Badge variant={r.overdue ? 'error' : r.status === 'PAID' ? 'success' : r.status === 'CANCELLED' ? 'secondary' : 'warning'}>
                        {r.overdue ? 'Vencida' : RECEIVABLE_STATUS[r.status] ?? r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.overdue ? `${r.daysOverdue} dias` : '—'}
                      {r.lateCharges && (
                        <span className="block text-xs text-muted-foreground">
                          multa {brl(r.lateCharges.fine)} + juros {brl(r.lateCharges.interest)} = {brl(r.lateCharges.total)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link className="text-primary hover:underline" href={`/dashboard/financial/receivables/${r.id}`}>
                        {r.overdue ? 'Abrir / enviar cobrança' : 'Abrir'}
                      </Link>
                      {r.collectionAttempts > 0 && <span className="block text-xs text-muted-foreground">{r.collectionAttempts} tentativa(s)</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Histórico (cadastro, bloqueios e desbloqueios)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem registros ainda (a auditoria é gravada de forma assíncrona).</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.history.map((h) => (
                <li key={h.id}>
                  {new Date(h.createdAt).toLocaleString('pt-BR')} — {h.value?.acao ?? h.action}
                  {h.value?.motivo ? `: ${h.value.motivo}` : ''}
                  {h.userId ? '' : ' (sistema)'}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog === 'block' ? 'Bloquear empresa conveniada' : 'Desbloquear empresa conveniada'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {dialog === 'block'
                ? 'Bloqueada, a empresa não compra pelo convênio. Histórico, dívida e cobrança continuam.'
                : 'A empresa volta a poder comprar pelo convênio (se o atraso continuar, a rotina automática pode bloquear de novo).'}
            </p>
            {actionError && <p className="text-sm text-danger">{actionError}</p>}
            <Label htmlFor="block-reason">Motivo (obrigatório, auditado)</Label>
            <Input id="block-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={saving || reason.trim().length < 5}>
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Kpi({ label, value, hint, strong, danger }: { label: string; value: string; hint?: string; strong?: boolean; danger?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`text-xl text-foreground ${strong ? 'font-extrabold' : 'font-bold'}`}>{value}</p>
      {hint && (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {danger && <span aria-label="inadimplente" className="h-2 w-2 rounded-full bg-danger" />}
          {hint}
        </p>
      )}
    </Card>
  );
}
