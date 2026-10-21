'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { AlertCircle, ArrowLeft, CheckCircle2, Download, History, Paperclip, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { HelpTabs } from '@/components/support/HelpTabs';
import { getCurrentUserClaims } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { supportApi, type TicketAttachment, type TicketDetail, type TicketMessage } from '@/lib/api/support';
import {
  AUTHOR_ROLE_LABEL,
  checkAttachment,
  eventPhrase,
  formatBytes,
  requesterActions,
  SUPPORT_STATUS_VARIANT,
  type SupportCatalog,
} from '@/lib/support';

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const DETAIL_LABEL: Record<string, string> = { customer: 'Cliente', vehicle: 'Veículo', status: 'Situação', dueDate: 'Vencimento', terminal: 'Terminal' };

function TicketView() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const [data, setData] = useState<TicketDetail | null>(null);
  const [older, setOlder] = useState<TicketMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [catalog, setCatalog] = useState<SupportCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const d = await supportApi.get(id);
      setData(d);
      setOlder([]);
      setHasOlder(d.hasMoreMessages);
      setError(null);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível abrir o chamado.'));
    }
  };

  useEffect(() => {
    setMe(getCurrentUserClaims()?.userId ?? null);
    supportApi.catalog().then(setCatalog).catch(() => undefined);
    if (search.get('novo')) {
      const failed = Number(search.get('anexosFalharam') ?? 0);
      setNotice(
        failed > 0
          ? `Chamado aberto. ${failed} anexo(s) não foram aceitos — confira o tipo/tamanho e anexe de novo abaixo.`
          : 'Chamado aberto. Você recebe a resposta aqui e o aviso aparece no menu Ajuda e Suporte.'
      );
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const labels = useMemo(() => {
    const m: Record<string, string> = {};
    catalog?.statuses.forEach((s) => (m[s.value] = s.label));
    catalog?.priorities.forEach((p) => (m[p.value] = p.label));
    return m;
  }, [catalog]);

  const run = async (fn: () => Promise<unknown>, fallback: string, ok?: string) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
      return true;
    } catch (err) {
      setActionError(getApiErrorMessage(err, fallback));
      if ((err as any)?.response?.status === 409) await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const loadOlder = async () => {
    const first = older[0] ?? data?.messages[0];
    if (!first) return;
    try {
      const d = await supportApi.get(id, first.createdAt);
      setOlder([...d.messages, ...older]);
      setHasOlder(d.hasMoreMessages);
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Não foi possível carregar as mensagens anteriores.'));
    }
  };

  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = reply.trim();
    if (!body) return;
    const ok = await run(() => supportApi.reply(id, body), 'Não foi possível enviar a mensagem.');
    if (ok) setReply('');
  };

  const attach = async (list: FileList | null) => {
    if (!list || !catalog) return;
    for (const f of Array.from(list)) {
      const problem = checkAttachment(f, catalog.attachments);
      if (problem) {
        setActionError(problem);
        continue;
      }
      await run(() => supportApi.attach(id, f), `Não foi possível anexar "${f.name}".`, `Anexo "${f.name}" incluído.`);
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const download = async (a: TicketAttachment) => {
    setActionError(null);
    try {
      await supportApi.download(a);
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Não foi possível baixar o anexo.'));
    }
  };

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <AlertCircle className="mx-auto mb-3 h-10 w-10 text-danger" aria-hidden />
          <p className="text-muted-foreground">{error}</p>
        </CardContent>
      </Card>
    );
  }
  if (!data) return <p className="text-muted-foreground">Carregando…</p>;

  const t = data.ticket;
  const isRequester = t.requester.id === me;
  const actions = requesterActions(t.status, isRequester);
  const messages = [...older, ...data.messages];
  const liveAttachments = data.attachments.filter((a) => !a.removed);
  const ctx = t.context;
  const ctxDetails = ctx?.details ? Object.entries(ctx.details).filter(([k, v]) => DETAIL_LABEL[k] && v) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">#{t.ticketNumber}</span>
            <Badge variant={SUPPORT_STATUS_VARIANT[t.status] ?? 'secondary'} data-testid="ticket-status">
              {t.statusLabel}
            </Badge>
          </div>
          <h2 className="mt-1 break-words text-2xl font-semibold text-foreground" data-testid="ticket-title">
            {t.subject}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t.moduleLabel} · {t.typeLabel} · prioridade {t.priorityLabel.toLowerCase()} · aberto em {when(t.createdAt)} por {t.requester.name}
            {t.branch?.name ? ` (${t.branch.name})` : ''}
          </p>
          <p className="text-sm text-muted-foreground">{t.assignedTo?.name ? `Em atendimento por ${t.assignedTo.name} (Suporte CÓRTEX)` : 'Aguardando a equipe de suporte assumir.'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.canReopen && (
            <Button variant="outline" disabled={busy} onClick={() => run(() => supportApi.reopen(id), 'Não foi possível reabrir.', 'Chamado reaberto.')}>
              O problema voltou — reabrir
            </Button>
          )}
          {actions.canClose && (
            <Button variant="outline" disabled={busy} onClick={() => setConfirmClose(true)} data-testid="ticket-close">
              <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden /> Encerrar chamado
            </Button>
          )}
        </div>
      </div>

      {notice && (
        <p className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <p className="flex items-center gap-2 rounded-lg border border-border bg-danger-soft p-3 text-sm text-danger" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden /> {actionError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Descrição</CardTitle>
            </CardHeader>
            <CardContent className="whitespace-pre-line break-words text-sm text-foreground">{t.description}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Conversa</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {hasOlder && (
                <Button variant="ghost" size="sm" onClick={loadOlder}>
                  Carregar mensagens anteriores
                </Button>
              )}
              {messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">Ainda não há mensagens. A equipe de suporte responde por aqui.</p>
              ) : (
                <ol className="space-y-3" data-testid="ticket-messages">
                  {messages.map((m) => {
                    const mine = m.author.id === me;
                    return (
                      <li key={m.id} className={`rounded-lg border p-3 ${m.author.role === 'SUPPORT' ? 'border-foreground/30 bg-muted' : 'border-border'} ${mine ? 'sm:ml-10' : 'sm:mr-10'}`}>
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{mine ? 'Você' : m.author.name}</span> · {AUTHOR_ROLE_LABEL[m.author.role] ?? m.author.role} · {when(m.createdAt)}
                        </p>
                        <p className="mt-1 whitespace-pre-line break-words text-sm text-foreground">{m.body}</p>
                      </li>
                    );
                  })}
                </ol>
              )}

              {actions.canReply ? (
                <form onSubmit={sendReply} className="space-y-2 border-t border-border pt-3">
                  <label htmlFor="t-reply" className="text-sm font-medium text-foreground">
                    Responder
                  </label>
                  <Textarea id="t-reply" data-testid="ticket-reply" rows={4} maxLength={10000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Escreva a sua mensagem" />
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy || !reply.trim()} data-testid="ticket-reply-send">
                      Enviar mensagem
                    </Button>
                    {t.status === 'RESOLVIDO' && <span className="self-center text-xs text-muted-foreground">Responder reabre o chamado.</span>}
                  </div>
                </form>
              ) : (
                <p className="border-t border-border pt-3 text-sm text-muted-foreground">
                  Chamado encerrado. Se precisar de mais ajuda, <Link className="underline" href="/dashboard/help/tickets/new">abra um novo chamado</Link> e cite o #{t.ticketNumber}.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {ctx && (ctx.label || ctx.screen) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Onde aconteceu</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="text-foreground">{[ctx.moduleLabel, ctx.screen, ctx.label].filter(Boolean).join(' → ')}</p>
                {ctx.terminal && <p className="text-muted-foreground">Terminal: {ctx.terminal}</p>}
                {ctxDetails.map(([k, v]) => (
                  <p key={k} className="text-muted-foreground">
                    {DETAIL_LABEL[k]}: {k === 'dueDate' ? new Date(String(v)).toLocaleDateString('pt-BR') : String(v)}
                  </p>
                ))}
                <p className="text-xs text-muted-foreground">
                  Origem: {t.sourceLabel}
                  {t.appVersion ? ` · versão ${t.appVersion}` : ''}
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Anexos</CardTitle>
              {actions.canAttach && catalog && (
                <>
                  <Button variant="outline" size="sm" disabled={busy || liveAttachments.length >= catalog.attachments.perTicket} onClick={() => fileInput.current?.click()}>
                    <Paperclip className="mr-1 h-4 w-4" aria-hidden /> Anexar
                  </Button>
                  <input ref={fileInput} type="file" multiple className="sr-only" accept=".png,.jpg,.jpeg,.pdf,.txt,.log" aria-label="Escolher anexos" onChange={(e) => attach(e.target.files)} data-testid="ticket-attach-input" />
                </>
              )}
            </CardHeader>
            <CardContent>
              {liveAttachments.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum anexo.</p>
              ) : (
                <ul className="space-y-2 text-sm" data-testid="ticket-attachments">
                  {liveAttachments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left text-foreground hover:underline" onClick={() => download(a)}>
                        <Download className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="truncate">{a.fileName}</span>
                      </button>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(a.size)}</span>
                      {a.uploadedBy.id === me && actions.canAttach && (
                        <button
                          type="button"
                          aria-label={`Remover ${a.fileName}`}
                          className="text-muted-foreground hover:text-foreground"
                          disabled={busy}
                          onClick={() => run(() => supportApi.removeAttachment(a.id), 'Não foi possível remover o anexo.', `Anexo "${a.fileName}" removido.`)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4" aria-hidden /> Histórico
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 border-l border-border pl-3 text-sm" data-testid="ticket-history">
                {data.events.map((e) => (
                  <li key={e.id}>
                    <p className="text-foreground">{eventPhrase(e, labels)}</p>
                    <p className="text-xs text-muted-foreground">{when(e.createdAt)}</p>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-muted-foreground">O histórico não pode ser alterado nem apagado.</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Encerrar o chamado #{t.ticketNumber}?</DialogTitle>
            <DialogDescription>Encerrado é final: se o problema voltar depois, será preciso abrir um novo chamado citando este número.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClose(false)}>
              Voltar
            </Button>
            <Button
              disabled={busy}
              data-testid="ticket-close-confirm"
              onClick={async () => {
                const ok = await run(() => supportApi.close(id), 'Não foi possível encerrar.', 'Chamado encerrado.');
                if (ok) setConfirmClose(false);
              }}
            >
              Encerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Chamado: conversa, onde aconteceu, anexos e histórico imutável. A API decide o que cada usuário pode ver e fazer. */
export default function TicketDetailPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Ajuda e Suporte</h1>
      </div>
      <HelpTabs />
      <Link href="/dashboard/help/tickets" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden /> Meus chamados
      </Link>
      <Suspense fallback={<p className="text-muted-foreground">Carregando…</p>}>
        <TicketView />
      </Suspense>
    </div>
  );
}
