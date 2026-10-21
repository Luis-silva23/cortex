'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { FULFILLMENT_NEXT, FULFILLMENT_STATUS_LABEL, FULFILLMENT_TYPE_LABEL, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, SCOPE_OPTIONS, canAcceptOrder, canActOnOrder, canCancelOrder, canConvertOrder, credentialState, parseSkus, type ChannelCredentialView, type ChannelOrderView, type ChannelScope } from '@/lib/sales-channels';

// Commerce API do canal (docs/CORTEX/COMMERCE_API.md): o site chama o CÓRTEX com uma credencial assinada. Aqui o administrador emite e
// revoga credenciais, publica produtos (nada é público até ser publicado) e acompanha os pedidos recebidos. O segredo de uma credencial
// aparece UMA vez, na criação, e nunca mais; um pedido recebido ainda não é venda, pagamento nem baixa de estoque.

const apiMessage = (e: any, fallback: string) => e?.response?.data?.error || e?.response?.data?.message || fallback;
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');
const money = (v: number | null) => (v === null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

type Notice = { tone: 'ok' | 'warn' | 'error'; text: string } | null;
function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const tone = notice.tone === 'ok' ? 'bg-success-soft text-success' : notice.tone === 'warn' ? 'bg-warning-soft text-warning' : 'bg-danger-soft text-danger';
  return (
    <p role="status" className={`rounded-md px-3 py-2 text-sm ${tone}`}>
      {notice.text}
    </p>
  );
}

function Credentials({ channelId }: { channelId: string }) {
  const [list, setList] = useState<ChannelCredentialView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<ChannelScope[]>(['CATALOG_READ']);
  const [expires, setExpires] = useState('');
  const [secretOnce, setSecretOnce] = useState<{ keyId: string; secret: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setList((await api.getChannelApiCredentials(channelId)).data);
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível carregar as credenciais.') });
    }
  }, [channelId]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível concluir a operação.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        O servidor do site assina cada chamada com a credencial (HMAC). O segredo só aparece uma vez, ao criar. Para o canal ficar <strong>conectado</strong>, o site precisa fazer a primeira chamada assinada.
      </p>

      {secretOnce && (
        <div role="alert" className="space-y-2 rounded-md border border-warning bg-warning-soft p-3 text-sm">
          <p className="font-medium text-warning">Copie o segredo agora: ele não será mostrado de novo.</p>
          <p className="text-xs">
            Identificador: <span className="font-mono">{secretOnce.keyId}</span>
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">{secretOnce.secret}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(secretOnce.secret)}>
              <Copy className="mr-1 h-3 w-3" /> Copiar
            </Button>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSecretOnce(null)}>
            Já guardei o segredo
          </Button>
        </div>
      )}

      <form
        className="space-y-2 rounded-md border border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await api.createChannelApiCredential(channelId, { label: label.trim(), scopes, expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null });
            setSecretOnce({ keyId: r.credential.keyId, secret: r.secret });
            setLabel('');
            setExpires('');
          });
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Label htmlFor={`cred-label-${channelId}`}>Nome da credencial</Label>
            <Input id={`cred-label-${channelId}`} value={label} maxLength={60} placeholder="Ex.: servidor da loja" onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <Label htmlFor={`cred-exp-${channelId}`}>Validade (opcional)</Label>
            <Input id={`cred-exp-${channelId}`} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
        </div>
        <fieldset className="grid gap-1 sm:grid-cols-2">
          <legend className="text-xs font-medium text-muted-foreground">O que esta credencial pode fazer</legend>
          {SCOPE_OPTIONS.map((s) => (
            <label key={s.value} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={scopes.includes(s.value)} onChange={(e) => setScopes((all) => (e.target.checked ? [...all, s.value] : all.filter((x) => x !== s.value)))} />
              <span>
                {s.label} <span className="text-xs text-muted-foreground">— {s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Button type="submit" size="sm" disabled={busy || label.trim().length < 2 || scopes.length === 0}>
          Criar credencial
        </Button>
      </form>

      <NoticeLine notice={notice} />

      {list === null ? (
        <p className="text-xs text-muted-foreground">Carregando…</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhuma credencial emitida.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border text-sm">
          {list.map((c) => {
            const state = credentialState(c);
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {c.label} <Badge variant={state === 'Ativa' ? 'success' : 'secondary'}>{state}</Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">{c.keyId}</span> · segredo {c.secretHint} · último uso {dateTime(c.lastUsedAt)} · validade {dateTime(c.expiresAt)}
                  </p>
                  <p className="text-xs text-muted-foreground">{c.scopes.map((s) => SCOPE_OPTIONS.find((o) => o.value === s)?.label ?? s).join(' · ')}</p>
                </div>
                {state === 'Ativa' && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm('Emitir uma nova credencial? A atual continua valendo por 24 horas.') && run(async () => { const r = await api.rotateChannelApiCredential(channelId, c.id); setSecretOnce({ keyId: r.credential.keyId, secret: r.secret }); })}>
                      Trocar
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm('Revogar agora? O site perde o acesso imediatamente.') && run(async () => { await api.revokeChannelApiCredential(channelId, c.id); })}>
                      Revogar
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Products({ channelId }: { channelId: string }) {
  const [text, setText] = useState('');
  const [published, setPublished] = useState<{ data: Array<{ sku: string; name: string; price: number; productActive: boolean }>; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getChannelProducts(channelId, { published: true, limit: 50 });
      setPublished({ data: r.data, total: r.pagination.total });
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível carregar os produtos publicados.') });
    }
  }, [channelId]);
  useEffect(() => {
    load();
  }, [load]);

  const skus = parseSkus(text);
  const act = async (value: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.setChannelProductsPublished(channelId, { skus, published: value });
      setNotice({
        tone: r.unknownSkus.length ? 'warn' : 'ok',
        text: `${r.updated} produto(s) ${value ? 'publicado(s)' : 'despublicado(s)'}.${r.unknownSkus.length ? ` Não encontrados nesta filial: ${r.unknownSkus.slice(0, 10).join(', ')}.` : ''}`,
      });
      setText('');
      await load();
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível concluir a operação.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Nada é público até ser publicado para este canal. Só produtos ativos da empresa ou da filial do canal aparecem para o site. O preço é sempre o do CÓRTEX.</p>
      <div>
        <Label htmlFor={`skus-${channelId}`}>SKUs (um por linha ou separados por vírgula)</Label>
        <textarea id={`skus-${channelId}`} className="min-h-[5rem] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || skus.length === 0} onClick={() => act(true)}>
          Publicar {skus.length > 0 ? `(${skus.length})` : ''}
        </Button>
        <Button size="sm" variant="outline" disabled={busy || skus.length === 0} onClick={() => act(false)}>
          Despublicar
        </Button>
      </div>
      <NoticeLine notice={notice} />
      {published && (
        <div className="rounded-md border border-border">
          <p className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
            Publicados: {published.total}
            {published.total > published.data.length ? ` (mostrando ${published.data.length})` : ''}
          </p>
          {published.data.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">Nenhum produto publicado.</p>
          ) : (
            <ul className="max-h-56 divide-y divide-border overflow-auto text-xs">
              {published.data.map((p) => (
                <li key={p.sku} className="flex justify-between gap-2 px-3 py-2">
                  <span>
                    <span className="font-mono">{p.sku}</span> · {p.name}
                    {!p.productActive && <span className="ml-2 text-danger">(produto inativo: o site não o vê)</span>}
                  </span>
                  <span>{money(p.price)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Orders({ channelId }: { channelId: string }) {
  const [orders, setOrders] = useState<ChannelOrderView[] | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      setOrders((await api.getChannelOrders(channelId, { status: status || undefined, limit: 50 })).data);
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível carregar os pedidos.') });
    }
  }, [channelId, status]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (okText) setNotice({ tone: 'ok', text: okText });
      await load();
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível concluir a operação.') });
    } finally {
      setBusy(false);
    }
  };

  const act = async (kind: 'reject' | 'cancel', o: ChannelOrderView) => {
    const reason = prompt(kind === 'reject' ? 'Motivo da recusa:' : 'Motivo do cancelamento:');
    if (!reason || reason.trim().length < 3) return;
    await run(() => (kind === 'reject' ? api.rejectChannelOrder(channelId, o.cortexOrderId, reason.trim()) : api.cancelChannelOrder(channelId, o.cortexOrderId, reason.trim())));
  };

  // Aceitar reserva o estoque (tudo ou nada); converter cria a venda (só com pagamento confirmado). A API decide e explica a recusa.
  const accept = (o: ChannelOrderView) => run(async () => { await api.acceptChannelOrder(channelId, o.cortexOrderId); }, 'Pedido aceito: estoque reservado até o prazo do canal (ainda não é venda).');
  const convertOrder = (o: ChannelOrderView) =>
    run(async () => {
      const r = await api.convertChannelOrder(channelId, o.cortexOrderId);
      setNotice({ tone: 'ok', text: `Pedido convertido na venda #${r.sale.saleNumber}${r.replayed ? ' (já estava convertido)' : ''}.` });
    });
  const moveFulfillment = (o: ChannelOrderView, status: string) => {
    let type: string | undefined;
    if (!o.fulfillment?.type && (status === 'IN_TRANSIT' || status === 'DELIVERED')) {
      const answer = prompt('Tipo de entrega: 1 = própria, 2 = do canal');
      type = answer === '1' ? 'OWN_DELIVERY' : answer === '2' ? 'CHANNEL_DELIVERY' : undefined;
      if (!type) return Promise.resolve();
    }
    if (status === 'PICKED_UP' && !o.fulfillment?.type) type = 'PICKUP';
    return run(async () => { await api.updateChannelFulfillment(channelId, o.cortexOrderId, { status, ...(type ? { type } : {}) }); });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Pedido recebido não é venda. Aceitar só RESERVA o estoque (por prazo); a venda nasce ao converter, com o pagamento confirmado, sem passar pelo caixa do balcão. O pagamento mostrado é o que o canal informou.</p>
      <div className="flex items-center gap-2">
        <Label htmlFor={`ostatus-${channelId}`} className="text-xs">
          Situação
        </Label>
        <select id={`ostatus-${channelId}`} className="h-9 rounded-md border border-border bg-card px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option>
          {['RECEIVED', 'ACCEPTED', 'EXPIRED', 'REJECTED', 'CANCELLED', 'CONVERTED'].map((s) => (
            <option key={s} value={s}>
              {ORDER_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <NoticeLine notice={notice} />
      {orders === null ? (
        <p className="text-xs text-muted-foreground">Carregando…</p>
      ) : orders.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhum pedido.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-border overflow-auto rounded-md border border-border text-sm">
          {orders.map((o) => (
            <li key={o.cortexOrderId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span className="font-mono">{o.orderId}</span> <Badge variant="outline">{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge>
                  <Badge variant={o.paymentStatus === 'CONFIRMED' ? 'success' : 'secondary'}>Pagamento: {PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus}</Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  {money(o.total)} · {o.items.length} item(ns) · recebido {dateTime(o.receivedAt)}
                  {o.statusReason ? ` · ${o.statusReason}` : ''}
                  {o.saleNumber ? ` · venda #${o.saleNumber}` : ''}
                </p>
                {o.fulfillment && (
                  <p className="text-xs text-muted-foreground">
                    Entrega: {FULFILLMENT_STATUS_LABEL[o.fulfillment.status] ?? o.fulfillment.status}
                    {o.fulfillment.type ? ` · ${FULFILLMENT_TYPE_LABEL[o.fulfillment.type] ?? o.fulfillment.type}` : ''}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {canAcceptOrder(o.status) && (
                  <Button size="sm" disabled={busy} onClick={() => accept(o)}>
                    Aceitar (reservar)
                  </Button>
                )}
                {canConvertOrder(o) && (
                  <Button size="sm" disabled={busy} onClick={() => convertOrder(o)}>
                    Converter em venda
                  </Button>
                )}
                {canActOnOrder(o.status) && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act('reject', o)}>
                    Recusar
                  </Button>
                )}
                {canCancelOrder(o.status) && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act('cancel', o)}>
                    Cancelar
                  </Button>
                )}
                {o.fulfillment &&
                  (FULFILLMENT_NEXT[o.fulfillment.status] ?? []).map((next) => (
                    <Button key={next} size="sm" variant="outline" disabled={busy} onClick={() => moveFulfillment(o, next)}>
                      {FULFILLMENT_STATUS_LABEL[next] ?? next}
                    </Button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CommerceApiPanel({ channelId }: { channelId: string }) {
  const [section, setSection] = useState<'credentials' | 'products' | 'orders'>('credentials');
  const tabs: Array<{ key: typeof section; label: string }> = [
    { key: 'credentials', label: 'Credenciais da API' },
    { key: 'products', label: 'Produtos publicados' },
    { key: 'orders', label: 'Pedidos recebidos' },
  ];
  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap gap-1 border-b border-border p-2" role="tablist" aria-label="Commerce API do canal">
        {tabs.map((t) => (
          <Button key={t.key} role="tab" aria-selected={section === t.key} size="sm" variant={section === t.key ? 'default' : 'ghost'} onClick={() => setSection(t.key)}>
            {t.label}
          </Button>
        ))}
      </div>
      <div className="p-3">
        {section === 'credentials' && <Credentials channelId={channelId} />}
        {section === 'products' && <Products channelId={channelId} />}
        {section === 'orders' && <Orders channelId={channelId} />}
      </div>
    </div>
  );
}
