'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, MessageCircle, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ReportProblemButton } from '@/components/support/ReportProblemButton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getCurrentUserClaims } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import {
  agreementsApi,
  ATTEMPT_STATUS_LABEL,
  brl,
  CHANNEL_LABEL,
  CollectionChannel,
  ReceivableDetail,
  SendCollectionResult,
} from '@/lib/api/agreements';

const STATUS: Record<string, string> = { PENDING: 'Em aberto', OVERDUE: 'Vencida', PAID: 'Recebida', CANCELLED: 'Cancelada' };
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

// Detalhe da conta a receber + COBRANÇA MANUAL: uma pessoa autorizada escolhe o(s) canal(is) e confirma; sai UMA mensagem
// por canal nesta ação. WhatsApp (provisório, sem API oficial): o CÓRTEX gera o link e esta tela abre o WhatsApp do
// usuário com a mensagem pronta — quem envia é o usuário. E-mail sem provedor configurado: registrado como "não enviado".
export default function ReceivableDetailPage() {
  const params = useParams() as { id: string };
  const [data, setData] = useState<ReceivableDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userType, setUserType] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<CollectionChannel[]>(['WHATSAPP']);
  const [actionKey, setActionKey] = useState(newKey());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [result, setResult] = useState<SendCollectionResult | null>(null);

  const load = () =>
    agreementsApi
      .getReceivable(params.id)
      .then(setData)
      .catch((e) => setError(getApiErrorMessage(e, 'Não foi possível carregar a conta.')));
  useEffect(() => {
    setUserType(getCurrentUserClaims()?.userType ?? null);
    load();
  }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function openDialog() {
    setChannels((data?.collection.channels ?? ['WHATSAPP']).slice(0, 1) as CollectionChannel[]);
    setActionKey(newKey()); // uma chave por ação humana: duplo clique não envia duas vezes
    setSendError(null);
    setOpen(true);
  }

  async function send() {
    setSending(true);
    setSendError(null);
    try {
      const res = await agreementsApi.sendCollection(params.id, channels, actionKey);
      setResult(res);
      setOpen(false);
      const wa = res.attempts.find((a) => a.channel === 'WHATSAPP' && a.link);
      if (wa?.link) window.open(wa.link, '_blank', 'noopener');
      await load();
    } catch (e) {
      setSendError(getApiErrorMessage(e, 'Não foi possível registrar a cobrança'));
    } finally {
      setSending(false);
    }
  }

  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Carregando...</p>;
  const canCollect = !!userType && data.collection.allowedRoles.includes(userType);
  const collectable = data.overdue;
  const toggle = (c: CollectionChannel) => setChannels((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  return (
    <div className="space-y-6">
      <Link href="/dashboard/financial" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> Financeiro
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{data.description}</h1>
          <p className="text-muted-foreground">
            {brl(data.amount)} · vencimento {new Date(data.dueDate).toLocaleDateString('pt-BR')} ·{' '}
            <Badge variant={data.overdue ? 'error' : data.status === 'PAID' ? 'success' : 'warning'}>{data.overdue ? 'Vencida' : STATUS[data.status] ?? data.status}</Badge>
            {data.overdue && <strong className="ml-2 text-danger">{data.daysOverdue} dias de atraso</strong>}
          </p>
          {data.lateCharges && (
            <p className="text-sm text-muted-foreground">
              Informativo (não lançado): multa {brl(data.lateCharges.fine)} + juros {brl(data.lateCharges.interest)} = {brl(data.lateCharges.total)}
            </p>
          )}
          {data.debtor && (
            <p className="text-sm">
              Devedor:{' '}
              {data.debtor.kind === 'AGREEMENT_COMPANY' ? (
                <Link className="text-primary hover:underline" href={`/dashboard/agreements/companies/${data.debtor.id}`}>
                  {data.debtor.name}
                </Link>
              ) : (
                data.debtor.name
              )}{' '}
              · WhatsApp {data.debtor.whatsapp ?? '—'} · E-mail {data.debtor.email ?? '—'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ReportProblemButton context={{ module: 'FINANCEIRO', screen: 'Financeiro → Cobrança', entityType: 'RECEIVABLE', entityId: data.id }} />
          {collectable && canCollect && (
            <Button onClick={openDialog}>
              <Send className="mr-2 h-4 w-4" /> ENVIAR COBRANÇA
            </Button>
          )}
        </div>
      </div>
      {collectable && !canCollect && <p className="text-sm text-muted-foreground">Somente {data.collection.allowedRoles.join(' / ')} podem enviar cobrança (política da empresa).</p>}
      <p className="text-xs text-muted-foreground">
        Cobrança manual: o CÓRTEX não envia nada sozinho. Cada clique registra uma mensagem por canal escolhido; a conversa seguinte é feita pelo responsável.
      </p>

      {result && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-lg">Resultado desta cobrança</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {result.attempts.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={a.status === 'SENT' || a.status === 'LINK_GENERATED' ? 'success' : 'error'}>{CHANNEL_LABEL[a.channel]}</Badge>
                <span>{ATTEMPT_STATUS_LABEL[a.status]}</span>
                <span className="text-muted-foreground">— {a.providerMessage}</span>
                {a.link && (
                  <a className="inline-flex items-center text-primary underline" href={a.link} target="_blank" rel="noopener noreferrer">
                    <MessageCircle className="mr-1 h-4 w-4" /> Abrir WhatsApp
                  </a>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Tentativas de cobrança</CardTitle>
        </CardHeader>
        <CardContent>
          {data.attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma cobrança enviada.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Data/hora</TableHead>
                  <TableHead>Quem</TableHead>
                  <TableHead>Canal</TableHead>
                  <TableHead>Destinatário</TableHead>
                  <TableHead>Valor / vencimento</TableHead>
                  <TableHead>Resultado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.attempts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.attempt}</TableCell>
                    <TableCell>{new Date(a.createdAt).toLocaleString('pt-BR')}</TableCell>
                    <TableCell>{a.sentByName ?? '—'}</TableCell>
                    <TableCell>{CHANNEL_LABEL[a.channel]}</TableCell>
                    <TableCell>{a.recipient ?? '—'}</TableCell>
                    <TableCell>
                      {brl(a.amount ?? 0)} · {a.dueDate ? new Date(a.dueDate).toLocaleDateString('pt-BR') : '—'}
                    </TableCell>
                    <TableCell>
                      {ATTEMPT_STATUS_LABEL[a.status]}
                      <span className="block text-xs text-muted-foreground">{a.providerMessage}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar cobrança</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {data.description} — {brl(data.amount)}, vencida há {data.daysOverdue} dias. Escolha o(s) canal(is): será UMA mensagem por canal.
            </p>
            {(['WHATSAPP', 'EMAIL'] as CollectionChannel[]).map((c) => (
              <label key={c} className={`flex items-center gap-2 ${data.collection.channels.includes(c) ? '' : 'opacity-50'}`}>
                <input type="checkbox" checked={channels.includes(c)} disabled={!data.collection.channels.includes(c)} onChange={() => toggle(c)} />
                {CHANNEL_LABEL[c]} ({c === 'WHATSAPP' ? data.debtor?.whatsapp ?? 'sem número' : data.debtor?.email ?? 'sem e-mail'})
                {c === 'WHATSAPP' && <span className="text-xs text-muted-foreground">— abre o seu WhatsApp com a mensagem pronta</span>}
              </label>
            ))}
            {sendError && <p className="text-danger">{sendError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={send} disabled={sending || channels.length === 0}>
              {sending ? 'Registrando...' : 'Confirmar envio'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
