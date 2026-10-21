'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, RefreshCw, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { supportAdminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '../../_components/confirm-dialog';
import { Badge, ErrorState, InlineNotice, LoadingState } from '../../_components/states';
import { TicketAttachments } from '../../_components/ticket-attachments';
import { TicketConversation } from '../../_components/ticket-conversation';
import { TicketHistory } from '../../_components/ticket-history';
import { useCurrentUser, useSupportAgents, useSupportCatalog } from '../../_lib/hooks';
import {
  CONTEXT_DETAIL_LABELS,
  contextDetailValue,
  errorCode,
  errorText,
  formatDateTime,
  priorityBadgeClass,
  priorityLabel,
  SETTABLE_STATUSES,
  statusBadgeClass,
  statusLabel,
  USER_TYPE_LABELS,
} from '../../_lib/format';
import type { TicketDetail, TicketMessage } from '../../_lib/types';

export default function SupportTicketDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? '');
  const { catalog } = useSupportCatalog();
  const { agents, error: agentsError } = useSupportAgents();
  const me = useCurrentUser();

  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [older, setOlder] = useState<TicketMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError('');
      try {
        const res = await supportAdminApi.ticket(id);
        setDetail(res.data);
        setOlder([]);
        setOlderHasMore(null);
      } catch (err) {
        setError(errorText(err, 'Não foi possível carregar o chamado.'));
      } finally {
        setLoading(false);
      }
    },
    [id]
  );

  useEffect(() => {
    load();
  }, [load]);

  async function loadOlder() {
    if (!detail) return;
    const oldest = older[0] ?? detail.messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const res = await supportAdminApi.ticket(id, { before: oldest.createdAt });
      const data = res.data as TicketDetail;
      setOlder((prev) => [...data.messages, ...prev]);
      setOlderHasMore(data.hasMoreMessages);
    } catch (err) {
      setActionError(errorText(err, 'Não foi possível carregar as mensagens anteriores.'));
    } finally {
      setLoadingOlder(false);
    }
  }

  /** Executa uma ação do chamado; em 409 SUPPORT_TICKET_CHANGED mostra a mensagem e recarrega. */
  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setActionError('');
    setActionNotice('');
    try {
      await fn();
      setActionNotice(success);
      await load(true);
    } catch (err) {
      setActionError(errorText(err, 'Não foi possível concluir a ação.'));
      if (errorCode(err) === 'SUPPORT_TICKET_CHANGED') await load(true);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !detail) return <LoadingState label="Carregando chamado..." />;
  if (error && !detail) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState message={error} onRetry={() => load()} />
      </div>
    );
  }
  if (!detail) return null;

  const t = detail.ticket;
  const closed = t.status === 'ENCERRADO';
  const messages = [...older, ...detail.messages];
  const hasMore = olderHasMore ?? detail.hasMoreMessages;
  const assignedToMe = !!me?.id && t.assignedTo?.id === me.id;
  const ctx = t.context;
  const ctxDetails = Object.entries(ctx?.details ?? {}).filter(([k, v]) => contextDetailValue(k, v) !== '');
  const hasContext = !!ctx && !!(ctx.label || ctx.screen || ctx.route || ctx.terminal || ctx.entityTypeLabel || ctxDetails.length);

  return (
    <div className="space-y-4" data-testid="ticket-detail" data-ticket-id={t.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BackLink />
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={busy}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Atualizar
        </Button>
      </div>

      {/* Cabeçalho */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="min-w-0">
            <p className="font-mono text-sm text-muted-foreground" data-testid="ticket-number">
              Chamado #{t.ticketNumber}
            </p>
            <h2 className="break-words text-xl font-semibold sm:text-2xl" data-testid="ticket-subject">
              {t.subject}
            </h2>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge className={statusBadgeClass(t.status)}>
              <span data-testid="ticket-status-badge">{statusLabel(t.status, catalog)}</span>
            </Badge>
            <Badge className={priorityBadgeClass(t.priority)}>
              <span data-testid="ticket-priority-badge">Prioridade {priorityLabel(t.priority, catalog).toLowerCase()}</span>
            </Badge>
            <Badge className="bg-secondary text-foreground">{t.typeLabel}</Badge>
            <Badge className="bg-secondary text-foreground">{t.moduleLabel}</Badge>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Meta label="Origem" value={t.sourceLabel} />
            <Meta label="Versão do app" value={t.appVersion || 'Não informada'} />
            <Meta label="Aberto em" value={formatDateTime(t.createdAt)} />
            <Meta label="Última atividade" value={formatDateTime(t.lastMessageAt)} />
            {t.resolvedAt && <Meta label="Resolvido em" value={formatDateTime(t.resolvedAt)} />}
            {t.closedAt && <Meta label="Encerrado em" value={formatDateTime(t.closedAt)} />}
          </dl>
        </CardContent>
      </Card>

      {actionError && <InlineNotice tone="error">{actionError}</InlineNotice>}
      {actionNotice && !actionError && <InlineNotice tone="success">{actionNotice}</InlineNotice>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Coluna principal */}
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">Descrição</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <p className="whitespace-pre-wrap break-words text-sm" data-testid="ticket-description">
                {t.description}
              </p>
            </CardContent>
          </Card>

          <TicketConversation
            ticketId={t.id}
            messages={messages}
            attachments={detail.attachments}
            hasMore={hasMore}
            loadingOlder={loadingOlder}
            onLoadOlder={loadOlder}
            catalog={catalog}
            closed={closed}
            onReplied={({ conflict }) => {
              setActionError('');
              if (!conflict) setActionNotice('Resposta enviada.');
              load(true);
            }}
          />
        </div>

        {/* Coluna lateral */}
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">Atendimento</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-2">
              <div className="space-y-1">
                <Label htmlFor="assign-select" className="text-xs">
                  Responsável
                </Label>
                <div className="flex gap-2">
                  <Select
                    id="assign-select"
                    className="h-9 min-w-0 flex-1 text-sm"
                    value={t.assignedTo?.id ?? ''}
                    disabled={busy || !agents}
                    onChange={(e) => {
                      const value = e.target.value || null;
                      const name = agents?.find((a) => a.id === value)?.name;
                      run(() => supportAdminApi.assign(t.id, value), value ? `Chamado atribuído a ${name ?? 'responsável'}.` : 'Chamado sem responsável.');
                    }}
                    data-testid="ticket-assign-select"
                  >
                    <option value="">Sem responsável</option>
                    {t.assignedTo && !agents?.some((a) => a.id === t.assignedTo?.id) && <option value={t.assignedTo.id}>{t.assignedTo.name}</option>}
                    {(agents ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.openTickets} em aberto)
                      </option>
                    ))}
                  </Select>
                  {!assignedToMe && me?.id && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={busy}
                      onClick={() => run(() => supportAdminApi.assign(t.id, me.id as string), 'Você assumiu o chamado.')}
                      data-testid="ticket-assume"
                    >
                      <UserCheck className="mr-1 h-4 w-4" />
                      Assumir
                    </Button>
                  )}
                </div>
                {agentsError && <p className="text-xs text-danger">{agentsError}</p>}
              </div>

              <div className="space-y-1">
                <Label htmlFor="status-select" className="text-xs">
                  Situação
                </Label>
                <Select
                  id="status-select"
                  className="h-9 text-sm"
                  value={t.status}
                  disabled={busy || closed}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === 'ENCERRADO') setConfirmClose(true);
                    else run(() => supportAdminApi.setStatus(t.id, value), `Situação alterada para ${statusLabel(value, catalog)}.`);
                  }}
                  data-testid="ticket-status-select"
                >
                  {!SETTABLE_STATUSES.includes(t.status) && (
                    <option value={t.status} disabled>
                      {statusLabel(t.status, catalog)}
                    </option>
                  )}
                  {SETTABLE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(s, catalog)}
                    </option>
                  ))}
                </Select>
                {closed && <p className="text-xs text-muted-foreground">Encerrado é definitivo: a situação não muda mais.</p>}
              </div>

              <div className="space-y-1">
                <Label htmlFor="priority-select" className="text-xs">
                  Prioridade
                </Label>
                <Select
                  id="priority-select"
                  className="h-9 text-sm"
                  value={t.priority}
                  disabled={busy}
                  onChange={(e) => {
                    const value = e.target.value;
                    run(() => supportAdminApi.setPriority(t.id, value), `Prioridade alterada para ${priorityLabel(value, catalog)}.`);
                  }}
                  data-testid="ticket-priority-select"
                >
                  {(catalog?.priorities ?? [{ value: t.priority, label: priorityLabel(t.priority) }]).map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">Solicitante</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <dl className="space-y-2 text-sm" data-testid="ticket-requester">
                <Meta label="Nome" value={t.requester.name} />
                <Meta label="Perfil" value={USER_TYPE_LABELS[t.requester.role] ?? t.requester.role} />
                {t.requesterEmail && <Meta label="E-mail" value={t.requesterEmail} breakAll />}
                {t.requesterPhone && <Meta label="Telefone" value={t.requesterPhone} />}
                <Meta label="Empresa" value={t.company.name} />
                {t.branch && <Meta label="Filial" value={t.branch.name} />}
              </dl>
            </CardContent>
          </Card>

          {hasContext && ctx && (
            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-base">Contexto</CardTitle>
                <p className="text-xs text-muted-foreground">Onde o cliente estava ao abrir o chamado.</p>
              </CardHeader>
              <CardContent className="p-4 pt-2">
                <dl className="space-y-2 text-sm" data-testid="ticket-context">
                  {ctx.label && <Meta label="Referência" value={ctx.label} />}
                  {ctx.entityTypeLabel && !ctx.label && <Meta label="Tipo de registro" value={ctx.entityTypeLabel} />}
                  {ctx.screen && <Meta label="Tela" value={ctx.screen} />}
                  {ctx.route && <Meta label="Endereço" value={ctx.route} breakAll />}
                  {ctx.terminal && <Meta label="Terminal" value={ctx.terminal} />}
                  {ctxDetails.map(([k, v]) => (
                    <Meta key={k} label={CONTEXT_DETAIL_LABELS[k] ?? k} value={contextDetailValue(k, v)} />
                  ))}
                </dl>
              </CardContent>
            </Card>
          )}

          <TicketAttachments ticketId={t.id} attachments={detail.attachments} catalog={catalog} closed={closed} onChanged={() => load(true)} />
          <TicketHistory events={detail.events} catalog={catalog} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmClose}
        title="Encerrar o chamado?"
        description="Encerrado é definitivo: o chamado não recebe mais respostas nem anexos e a situação não pode ser mudada depois. Se o cliente precisar, ele abre um novo chamado."
        confirmLabel="Encerrar chamado"
        destructive
        busy={busy}
        onCancel={() => setConfirmClose(false)}
        onConfirm={async () => {
          await run(() => supportAdminApi.setStatus(t.id, 'ENCERRADO'), 'Chamado encerrado.');
          setConfirmClose(false);
        }}
        testId="confirm-close-ticket"
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/dashboard/support/tickets" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" />
      Chamados
    </Link>
  );
}

function Meta({ label, value, breakAll }: { label: string; value: string; breakAll?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn(breakAll ? 'break-all' : 'break-words')}>{value}</dd>
    </div>
  );
}
