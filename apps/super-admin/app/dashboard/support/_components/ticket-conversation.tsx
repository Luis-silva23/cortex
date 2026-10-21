'use client';

import { useRef, useState } from 'react';
import { Paperclip, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { supportAdminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { InlineNotice } from './states';
import { downloadAttachment } from './ticket-attachments';
import { AUTHOR_ROLE_LABELS, errorCode, errorText, formatDateTime, newIdempotencyKey, SETTABLE_STATUSES, statusLabel } from '../_lib/format';
import type { SupportCatalog, TicketAttachment, TicketMessage } from '../_lib/types';

const MESSAGE_MAX = 10_000;

interface Props {
  ticketId: string;
  messages: TicketMessage[];
  attachments: TicketAttachment[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  catalog: SupportCatalog | null;
  closed: boolean;
  onReplied: (info: { conflict: boolean; message?: string }) => void;
}

export function TicketConversation({ ticketId, messages, attachments, hasMore, loadingOlder, onLoadOlder, catalog, closed, onReplied }: Props) {
  const [body, setBody] = useState('');
  const [nextStatus, setNextStatus] = useState('AGUARDANDO_USUARIO');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // Mesma chave só para repetir um envio idêntico que caiu na rede (sem resposta); qualquer resposta do servidor a descarta.
  const pendingKey = useRef<{ payload: string; key: string } | null>(null);

  const byMessage = new Map<string, TicketAttachment[]>();
  attachments.forEach((a) => {
    if (!a.messageId) return;
    byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a]);
  });

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text) {
      setError('Escreva a resposta antes de enviar.');
      return;
    }
    setSending(true);
    setError('');
    const payload = { body: text, status: nextStatus };
    const serialized = JSON.stringify(payload);
    if (!pendingKey.current || pendingKey.current.payload !== serialized) pendingKey.current = { payload: serialized, key: newIdempotencyKey() };
    try {
      await supportAdminApi.reply(ticketId, payload, pendingKey.current.key);
      pendingKey.current = null;
      setBody('');
      setNextStatus('AGUARDANDO_USUARIO');
      onReplied({ conflict: false });
    } catch (err: any) {
      if (err?.response) pendingKey.current = null;
      const message = errorText(err, 'Não foi possível enviar a resposta.');
      if (errorCode(err) === 'SUPPORT_TICKET_CHANGED') onReplied({ conflict: true, message });
      setError(message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Conversa</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-2">
        {hasMore && (
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={onLoadOlder} disabled={loadingOlder} data-testid="load-older-messages">
              {loadingOlder ? 'Carregando...' : 'Carregar mensagens anteriores'}
            </Button>
          </div>
        )}
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ainda não há mensagens além da descrição inicial.</p>
        ) : (
          <ol className="space-y-3" data-testid="ticket-messages">
            {messages.map((m) => {
              const support = m.author.role === 'SUPPORT';
              const files = byMessage.get(m.id) ?? [];
              return (
                <li
                  key={m.id}
                  data-testid="ticket-message"
                  data-role={m.author.role}
                  className={cn('rounded-lg border p-3', support ? 'border-foreground/20 bg-muted/60 sm:ml-8' : 'bg-card sm:mr-8')}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 text-sm">
                      <span className="font-semibold">{m.author.name}</span>{' '}
                      <span className="text-xs text-muted-foreground">· {AUTHOR_ROLE_LABELS[m.author.role] ?? m.author.role}</span>
                    </p>
                    <span className="text-xs text-muted-foreground">{formatDateTime(m.createdAt)}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm">{m.body}</p>
                  {files.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {files.map((a) => (
                        <li key={a.id}>
                          {a.removed ? (
                            <span className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground line-through">
                              <Paperclip className="h-3 w-3" />
                              {a.fileName}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="inline-flex max-w-full items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent"
                              onClick={() => downloadAttachment(a).catch(() => setError('Não foi possível baixar o anexo.'))}
                            >
                              <Paperclip className="h-3 w-3 shrink-0" />
                              <span className="truncate">{a.fileName}</span>
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {m.statusFrom && m.statusTo && m.statusFrom !== m.statusTo && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Situação: {statusLabel(m.statusFrom, catalog)} → {statusLabel(m.statusTo, catalog)}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {closed ? (
          <InlineNotice tone="info">Chamado encerrado não recebe resposta. Se o cliente precisar, ele abre um novo chamado citando este número.</InlineNotice>
        ) : (
          <form onSubmit={submit} className="space-y-3 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="reply-body">Responder ao cliente</Label>
              <Textarea
                id="reply-body"
                rows={5}
                maxLength={MESSAGE_MAX}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
                }}
                placeholder="Escreva a resposta. O cliente vê este texto exatamente como está."
                data-testid="reply-textarea"
              />
              <p className="text-right text-xs text-muted-foreground">
                {body.length.toLocaleString('pt-BR')} / {MESSAGE_MAX.toLocaleString('pt-BR')} · Ctrl+Enter envia
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-1 sm:w-64">
                <Label htmlFor="reply-status" className="text-xs">
                  Situação após responder
                </Label>
                <Select id="reply-status" className="h-9 text-sm" value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} data-testid="reply-status-select">
                  {SETTABLE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(s, catalog)}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" disabled={sending || !body.trim()} data-testid="reply-submit">
                <Send className="mr-2 h-4 w-4" />
                {sending ? 'Enviando...' : 'Enviar resposta'}
              </Button>
            </div>
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
