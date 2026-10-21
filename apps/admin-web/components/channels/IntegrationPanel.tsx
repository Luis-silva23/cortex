'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { INBOUND_OUTCOME_LABEL, OUTBOX_STATUS_LABEL, OUTBOX_TYPE_LABEL, canRetryOutbox, webhookUrl, type OutboxRowView } from '@/lib/sales-channels';

// Integration Gateway do canal com provedor (docs/CORTEX/COMMERCE_API.md §12): o provedor chama o CÓRTEX por webhook assinado e o
// CÓRTEX avisa o provedor por uma CAIXA DE SAÍDA (nada é enviado no caminho da venda). Aqui o administrador vê o endereço do webhook,
// o que está na fila, o que falhou e pode reenviar. O segredo do webhook fica só na credencial cifrada: nunca aparece nesta tela.

const apiMessage = (e: any, fallback: string) => e?.response?.data?.error || e?.response?.data?.message || fallback;
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

type Notice = { tone: 'ok' | 'error'; text: string } | null;

export function IntegrationPanel({ channelId, provider }: { channelId: string; provider: string }) {
  const [rows, setRows] = useState<OutboxRowView[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [inbound, setInbound] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getChannelOutbox(channelId, { limit: 30 });
      setRows(r.data);
      setCounts(r.counts);
      setInbound(r.inboundCounts);
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível carregar a integração.') });
    }
  }, [channelId]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ tone: 'ok', text });
      await load();
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível concluir a operação.') });
    } finally {
      setBusy(false);
    }
  };

  const url = webhookUrl(API_URL, channelId);
  const dead = counts.DEAD ?? 0;

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <p className="text-sm font-medium">Integração — provedor &quot;{provider}&quot;</p>
        <p className="text-xs text-muted-foreground">
          O provedor avisa o CÓRTEX neste endereço (assinado com o segredo do webhook que está na credencial do canal). O que o CÓRTEX precisa dizer ao provedor sai por uma fila, com nova tentativa
          automática; a venda nunca espera pelo provedor.
        </p>
        <p className="mt-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">{url}</p>
      </div>

      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === 'ok' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
          {notice.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        {Object.entries(OUTBOX_STATUS_LABEL).map(([status, label]) => (
          <Badge key={status} variant={status === 'DEAD' && dead > 0 ? 'error' : 'outline'}>
            {label}: {counts[status] ?? 0}
          </Badge>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {Object.entries(INBOUND_OUTCOME_LABEL).map(([outcome, label]) => (
          <Badge key={outcome} variant="secondary">
            Eventos recebidos · {label}: {inbound[outcome] ?? 0}
          </Badge>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {(['inventory', 'price', 'catalog'] as const).map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.syncChannel(channelId, kind);
                return r.data.enqueued > 0 ? `${r.data.items} item(ns) na fila para envio.` : 'Já havia um envio igual na fila neste minuto.';
              })
            }
          >
            Enviar {kind === 'inventory' ? 'estoque disponível' : kind === 'price' ? 'preços' : 'catálogo'}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => undefined)}>
          Atualizar
        </Button>
      </div>

      {rows === null ? (
        <p className="text-xs text-muted-foreground">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nada na fila de saída.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-auto rounded-md border border-border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {OUTBOX_TYPE_LABEL[r.type] ?? r.type} <Badge variant={r.status === 'DEAD' ? 'error' : r.status === 'SENT' ? 'success' : 'outline'}>{OUTBOX_STATUS_LABEL[r.status] ?? r.status}</Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  tentativa {r.attempts}/{r.maxAttempts} · {r.sentAt ? `enviado ${dateTime(r.sentAt)}` : `próxima ${dateTime(r.nextAttemptAt)}`}
                  {r.lastError ? ` · ${r.lastError}` : ''}
                </p>
              </div>
              {canRetryOutbox(r.status) && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await api.retryChannelOutbox(channelId, r.id); return 'Linha devolvida para nova tentativa.'; })}>
                    Reenviar agora
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await api.cancelChannelOutbox(channelId, r.id); return 'Linha cancelada.'; })}>
                    Cancelar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
