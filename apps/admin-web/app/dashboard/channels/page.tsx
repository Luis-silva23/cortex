'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { CommerceApiPanel } from '@/components/channels/CommerceApiPanel';
import { IntegrationPanel } from '@/components/channels/IntegrationPanel';
import { CHANNEL_TYPE_OPTIONS, CONNECTION_STATUS_LABEL, EVENT_LEVEL_LABEL, usesCommerceApi, type ChannelConnectionStatus, type SalesChannelType, type SalesChannelView } from '@/lib/sales-channels';

// Canais de venda (módulo CANAIS, que nasce DESATIVADO). Aqui só se configura: tipo, nome exibido, ativo, credencial e teste de
// conexão. Nenhum provedor real está instalado nesta etapa: o teste de conexão diz isso e o canal NUNCA aparece como "Conectado"
// sem um teste real. A credencial é só escrita (a API nunca a devolve; a tela mostra apenas uma dica "••••1234").

const STATUS_VARIANT: Record<ChannelConnectionStatus, 'secondary' | 'warning' | 'success' | 'error'> = {
  NOT_CONFIGURED: 'secondary',
  UNVALIDATED: 'warning',
  CONNECTED: 'success',
  ERROR: 'error',
};

const apiMessage = (e: any, fallback: string) => e?.response?.data?.error || e?.response?.data?.message || fallback;

function ChannelCard({ channel, branchName, onChanged }: { channel: SalesChannelView; branchName: string; onChanged: () => void }) {
  const [name, setName] = useState(channel.displayName);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [credOpen, setCredOpen] = useState(false);
  const [fields, setFields] = useState<Array<{ key: string; value: string }>>([{ key: 'clientId', value: '' }, { key: 'clientSecret', value: '' }]);
  const [events, setEvents] = useState<Array<{ id: string; type: string; level: string; message: string; createdAt: string }> | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: 'error', text: apiMessage(e, 'Não foi possível concluir a operação.') });
    } finally {
      setBusy(false);
    }
  };

  const isStore = channel.type === 'LOJA_FISICA';
  // Canal com provedor registrado (Integration Gateway) usa credencial/teste de conexão como qualquer provedor, mesmo sendo do tipo "outro".
  const isCommerce = usesCommerceApi(channel.type) && !channel.provider;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex flex-wrap items-center gap-2">
            {channel.displayName}
            <Badge variant="outline">{channel.typeLabel}</Badge>
            <Badge variant={channel.isActive ? 'success' : 'secondary'}>{channel.isActive ? 'Ativo' : 'Desativado'}</Badge>
          </span>
          <Badge variant={STATUS_VARIANT[channel.connectionStatus]}>
            {isStore ? 'Sem integração' : isCommerce && channel.connectionStatus === 'CONNECTED' ? 'Conectado (chamada assinada recebida)' : CONNECTION_STATUS_LABEL[channel.connectionStatus]}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {branchName} · identificador técnico <span className="font-mono">{channel.type}</span> (não muda) ·{' '}
          {channel.hasCredentials ? `credencial salva (${channel.credentialsHint ?? '••••'})` : 'sem credencial'} · última sincronização: {channel.lastSyncAt ? new Date(channel.lastSyncAt).toLocaleString('pt-BR') : 'nunca'}
        </p>
        {channel.lastError && <p className="text-xs text-danger">Último erro: {channel.lastError}</p>}

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Label htmlFor={`name-${channel.id}`}>Nome exibido no painel</Label>
            <Input id={`name-${channel.id}`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" disabled={busy || name.trim() === channel.displayName || name.trim().length < 2} onClick={() => run(async () => { await api.updateSalesChannel(channel.id, { displayName: name.trim() }); onChanged(); })}>
            Salvar nome
          </Button>
          {!isStore && (
            <Button
              variant={channel.isActive ? 'outline' : 'default'}
              size="sm"
              disabled={busy}
              onClick={() => run(async () => { await api.updateSalesChannel(channel.id, { isActive: !channel.isActive }); onChanged(); })}
            >
              {channel.isActive ? 'Desativar' : 'Ativar'}
            </Button>
          )}
        </div>

        {!isStore && (
          <div className="flex flex-wrap gap-2">
            {/* Canal de site/outro usa a Commerce API (o site chama o CÓRTEX): não há credencial de provedor nem teste de conexão. */}
            {!isCommerce && (
              <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setCredOpen((o) => !o)}>
                  {channel.hasCredentials ? 'Trocar credencial' : 'Cadastrar credencial'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await api.testSalesChannelConnection(channel.id);
                      setNotice({ tone: r.ok ? 'ok' : 'warn', text: r.message });
                      onChanged();
                    })
                  }
                >
                  <Plug className="mr-2 h-4 w-4" /> Testar conexão
                </Button>
                {channel.hasCredentials && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api.clearSalesChannelCredentials(channel.id); onChanged(); })}>
                    Remover credencial
                  </Button>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  setEvents((await api.getSalesChannelEvents(channel.id)).data);
                })
              }
            >
              Ver registro de eventos
            </Button>
          </div>
        )}

        {isCommerce && <CommerceApiPanel channelId={channel.id} />}
        {!isStore && channel.provider && channel.connectionStatus !== 'NOT_CONFIGURED' && <IntegrationPanel channelId={channel.id} provider={channel.provider} />}

        {credOpen && (
          <form
            className="space-y-3 rounded-md border border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const credentials = Object.fromEntries(fields.filter((f) => f.key.trim() && f.value).map((f) => [f.key.trim(), f.value]));
              run(async () => {
                await api.setSalesChannelCredentials(channel.id, credentials);
                setFields([{ key: 'clientId', value: '' }, { key: 'clientSecret', value: '' }]);
                setCredOpen(false);
                setNotice({ tone: 'warn', text: 'Credencial salva e protegida. O canal só fica conectado depois de um teste de conexão bem-sucedido.' });
                onChanged();
              });
            }}
          >
            <p className="text-xs text-muted-foreground">Os valores são gravados cifrados e nunca mais aparecem nesta tela. Os nomes dos campos dependem do provedor.</p>
            {fields.map((f, i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <Input aria-label="Nome do campo" placeholder="Campo (ex.: clientId)" value={f.key} onChange={(e) => setFields((all) => all.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                <Input aria-label="Valor do campo" type="password" autoComplete="new-password" placeholder="Valor" value={f.value} onChange={(e) => setFields((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              </div>
            ))}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={fields.length >= 6} onClick={() => setFields((all) => [...all, { key: '', value: '' }])}>
                + campo
              </Button>
              <Button type="submit" size="sm" disabled={busy || !fields.some((f) => f.key.trim() && f.value)}>
                Salvar credencial
              </Button>
            </div>
          </form>
        )}

        {notice && (
          <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === 'ok' ? 'bg-success-soft text-success' : notice.tone === 'warn' ? 'bg-warning-soft text-warning' : 'bg-danger-soft text-danger'}`}>
            {notice.text}
          </p>
        )}

        {events && (
          <div className="rounded-md border border-border">
            <p className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">Registro de eventos (sem segredos)</p>
            {events.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">Nenhum evento.</p>
            ) : (
              <ul className="max-h-56 divide-y divide-border overflow-auto text-xs">
                {events.map((e) => (
                  <li key={e.id} className="px-3 py-2">
                    <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString('pt-BR')}</span> · {EVENT_LEVEL_LABEL[e.level] ?? e.level} · {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<SalesChannelView[] | null>(null);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<SalesChannelType>('SITE_PROPRIO');
  const [displayName, setDisplayName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setChannels((await api.getSalesChannels()).data);
    } catch (e: any) {
      setChannels([]);
      setError(apiMessage(e, 'Não foi possível carregar os canais.'));
    }
  }, []);

  useEffect(() => {
    load();
    api
      .getBranches()
      .then((r: any) => setBranches((r?.data ?? []).map((b: any) => ({ id: b.id, name: b.name }))))
      .catch(() => setBranches([]));
  }, [load]);

  const branchName = (id: string | null) => (id ? branches.find((b) => b.id === id)?.name ?? 'Filial' : 'Todas as filiais');

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Canais de venda</h1>
          <p className="mt-1 text-muted-foreground">Origens da venda além da loja física: site próprio, iFood e marketplaces.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} aria-label="Atualizar canais">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-1 pt-6 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Nenhuma integração real está ativa.</span> Cadastrar um canal e salvar a credencial não conecta nada: o canal só fica &quot;Conectado&quot; depois de um teste de conexão
            bem-sucedido de um provedor homologado, e canal com integração só pode ser ativado nesse estado.
          </p>
          <p>Canal desativado não aparece no painel gerencial. A loja física existe sempre; cadastrá-la aqui serve só para trocar o nome exibido.</p>
        </CardContent>
      </Card>

      {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Novo canal</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              setCreating(true);
              try {
                await api.createSalesChannel({ type, displayName: displayName.trim(), branchId: branchId || null });
                setDisplayName('');
                await load();
              } catch (err) {
                setError(apiMessage(err, 'Não foi possível criar o canal.'));
              } finally {
                setCreating(false);
              }
            }}
          >
            <div>
              <Label htmlFor="ch-type">Tipo</Label>
              <select id="ch-type" value={type} onChange={(e) => setType(e.target.value as SalesChannelType)} className="mt-1 h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground">
                {CHANNEL_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="ch-name">Nome exibido</Label>
              <Input id="ch-name" className="mt-1" value={displayName} maxLength={60} placeholder="Ex.: E-commerce" onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ch-branch">Vale para</Label>
              <select id="ch-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground">
                <option value="">Todas as filiais</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={creating || displayName.trim().length < 2}>
              Criar canal
            </Button>
          </form>
        </CardContent>
      </Card>

      {channels === null ? (
        <p className="text-sm text-muted-foreground">Carregando canais…</p>
      ) : channels.length === 0 && !error ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nenhum canal cadastrado. O painel mostra só a loja física.</p>
      ) : (
        <div className="space-y-4">
          {channels.map((c) => (
            <ChannelCard key={`${c.id}-${c.updatedAt}`} channel={c} branchName={branchName(c.branchId)} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}
