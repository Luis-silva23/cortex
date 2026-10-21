'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Search, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';

type Customer = { id: string; name: string; document?: string | null; email?: string | null };
type PrivacyRequest = {
  id: string;
  requestType: 'EXPORT' | 'ANONYMIZE';
  subjectId: string;
  status: 'PLANNED' | 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED';
  requestedAt: string;
  executedAt?: string | null;
  retainedUntil?: string | null;
  plan?: any;
  result?: any;
  exportAvailable?: boolean;
  exportExpiresAt?: string | null;
};

const STATUS: Record<string, string> = {
  PLANNED: 'Planejado (aguarda confirmação)',
  COMPLETED: 'Concluído',
  PARTIAL: 'Concluído em parte (há retenção)',
  BLOCKED: 'Bloqueado (nada foi alterado)',
  FAILED: 'Falhou (nada foi alterado)',
};
const BLOCKED: Record<string, string> = {
  OPEN_RECEIVABLES: 'há cobranças em aberto (contas a receber pendentes ou vencidas)',
  OPEN_SALES: 'há vendas não quitadas',
  OPEN_SERVICE_ORDERS: 'há ordens de serviço em andamento',
  ALREADY_ANONYMIZED: 'este cadastro já foi anonimizado',
};
const RETAIN: Record<string, string> = {
  FISCAL_DOCUMENT_RETENTION: 'nome e CPF/CNPJ ficam por obrigação fiscal',
  ACTIVE_WARRANTY: 'placa, chassi e motor ficam enquanto a garantia estiver vigente',
  APPEND_ONLY_EVIDENCE: 'o destinatário das tentativas de cobrança fica (evidência que não pode ser reescrita)',
  SECURITY_ACCOUNTABILITY_APPEND_ONLY: 'a trilha de auditoria não é alterada',
};
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '');

/**
 * Pedidos de titular (LGPD) — só o administrador da empresa. Exportar entrega um arquivo (24 h, até 3 downloads); anonimizar é
 * IRREVERSÍVEL, mostra antes o que muda e o que a lei manda manter, e exige a senha. Tudo fica registrado.
 */
export default function PrivacyPage() {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [justification, setJustification] = useState('');
  const [password, setPassword] = useState('');
  const [planned, setPlanned] = useState<PrivacyRequest | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [history, setHistory] = useState<PrivacyRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.http.get('/privacy/requests');
      setHistory(data.data ?? []);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar os pedidos.'));
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    if (search.trim().length < 2) return;
    setError(null);
    try {
      const result = await api.getCustomers({ page: 1, limit: 10, search: search.trim() });
      setResults(result?.customers ?? []);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível buscar clientes.'));
    }
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível concluir o pedido.'));
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  const download = async (id: string) => {
    const response = await api.http.get(`/privacy/requests/${id}/download`, { responseType: 'blob' });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = /filename="([^"]+)"/.exec(String(response.headers['content-disposition'] ?? ''))?.[1] ?? 'titular.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportData = () =>
    run(async () => {
      if (!selected) return;
      const { data } = await api.http.post('/privacy/requests', { type: 'EXPORT', customerId: selected.id, justification, password });
      await download(data.data.id);
      setNotice('Arquivo gerado e baixado. Ele fica disponível por 24 horas (até 3 downloads) e depois é apagado do sistema.');
      await loadHistory();
    });

  const plan = () =>
    run(async () => {
      if (!selected) return;
      const { data } = await api.http.post('/privacy/requests', { type: 'ANONYMIZE', customerId: selected.id, justification });
      setPlanned(data.data);
      setUnderstood(false);
      await loadHistory();
    });

  const execute = () =>
    run(async () => {
      if (!planned) return;
      const { data } = await api.http.post(`/privacy/requests/${planned.id}/execute`, { password });
      setPlanned(null);
      setNotice(`Anonimização: ${STATUS[data.data.status] ?? data.data.status}.`);
      await loadHistory();
    });

  const blocked: { code: string; count: number }[] = planned?.plan?.blocked ?? [];

  return (
    <div className="space-y-6 p-6" data-testid="privacy-page">
      <div>
        <h1 className="text-2xl font-bold">Privacidade — pedidos de titular (LGPD)</h1>
        <p className="text-sm text-muted-foreground">
          Atenda o pedido de um cliente para receber uma cópia dos dados dele ou para anonimizar o cadastro. Só o administrador da empresa faz isto, com a
          sua senha, e tudo fica registrado. Orientações em docs/privacidade (minutas sem revisão jurídica).
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && <p className="rounded border border-border bg-muted px-3 py-2 text-sm">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Quem é o titular?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={find} className="flex gap-2">
            <Input aria-label="Buscar cliente por nome, CPF/CNPJ ou e-mail" placeholder="Nome, CPF/CNPJ ou e-mail" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button type="submit" variant="outline">
              <Search className="mr-2 h-4 w-4" />
              Buscar
            </Button>
          </form>
          {results.length > 0 && !selected && (
            <ul className="divide-y rounded border" aria-label="Clientes encontrados">
              {results.map((c) => (
                <li key={c.id}>
                  <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => { setSelected(c); setPlanned(null); }}>
                    {c.name} {c.document ? `· ${c.document}` : ''} {c.email ? `· ${c.email}` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selected && (
            <p className="text-sm">
              Titular selecionado: <strong>{selected.name}</strong>{' '}
              <button type="button" className="text-muted-foreground underline" onClick={() => { setSelected(null); setPlanned(null); }}>
                trocar
              </button>
            </p>
          )}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Justificativa e ação</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea aria-label="Justificativa do pedido" placeholder="Ex.: pedido do titular por e-mail, protocolo 2026-0001 (10 a 500 caracteres)" value={justification} onChange={(e) => setJustification(e.target.value)} maxLength={500} />
            <Input type="password" aria-label="Sua senha de administrador" placeholder="Sua senha (para exportar ou confirmar)" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy || justification.trim().length < 10 || !password} onClick={exportData}>
                <Download className="mr-2 h-4 w-4" />
                Exportar os dados do titular
              </Button>
              <Button type="button" variant="outline" disabled={busy || justification.trim().length < 10} onClick={plan}>
                <ShieldAlert className="mr-2 h-4 w-4" />
                Planejar anonimização
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {planned && (
        <Card data-testid="anonymization-plan">
          <CardHeader>
            <CardTitle className="text-base">3. Confirmar a anonimização (irreversível)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {blocked.length > 0 ? (
              <div className="rounded border border-danger/30 bg-danger-soft p-3 text-danger">
                <p className="font-medium">Não é possível anonimizar agora:</p>
                <ul className="list-disc pl-5">
                  {blocked.map((b) => (
                    <li key={b.code}>
                      {BLOCKED[b.code] ?? b.code} ({b.count})
                    </li>
                  ))}
                </ul>
                <p className="mt-1">Nada foi alterado. Resolva a pendência e faça um novo pedido.</p>
              </div>
            ) : (
              <>
                <p>
                  Serão <strong>sobrescritos no banco</strong>: contato, endereço, observações do cadastro
                  {planned.plan?.keepIdentification ? '' : ', nome e CPF/CNPJ'} e os textos livres ligados ao cliente (orçamentos, ordens de serviço, revisões, agenda, garantias).
                  Valores, datas e números de vendas e financeiro <strong>não mudam</strong>.
                </p>
                {(planned.plan?.retain ?? []).length > 0 && (
                  <div className="rounded border border-border p-3">
                    <p className="font-medium">O que fica por obrigação ou necessidade:</p>
                    <ul className="list-disc pl-5">
                      {(planned.plan.retain as any[]).map((r) => (
                        <li key={r.category}>
                          {RETAIN[r.reason] ?? r.reason} (até {date(r.until)})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="text-muted-foreground">
                  Não são alterados: trilha de auditoria, pedidos de canais externos (o conteúdo não tem vínculo com o cadastro) e cópias de segurança.
                </p>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1" />
                  <span>Entendo que a anonimização não pode ser desfeita.</span>
                </label>
                <Button type="button" disabled={busy || !understood || !password} onClick={execute}>
                  Anonimizar definitivamente
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pedidos registrados</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum pedido ainda.</p>
          ) : (
            <table className="w-full text-sm" aria-label="Pedidos de titular">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">Data</th>
                  <th>Tipo</th>
                  <th>Situação</th>
                  <th>Retenção até</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-1">{date(r.requestedAt)}</td>
                    <td>{r.requestType === 'EXPORT' ? 'Exportação' : 'Anonimização'}</td>
                    <td>{STATUS[r.status] ?? r.status}</td>
                    <td>{date(r.retainedUntil)}</td>
                    <td>
                      {r.requestType === 'EXPORT' && r.exportAvailable && (
                        <Button type="button" size="sm" variant="outline" onClick={() => run(async () => { await download(r.id); await loadHistory(); })}>
                          Baixar (até {date(r.exportExpiresAt)})
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
