'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import api, { monitoringApi, apiErrorMessage, type MonitoringThresholdRow, type ThresholdScope } from '@/lib/api';
import { ErrorState, LoadingState } from '../../../observability/_components/states';

const SOURCE_LABEL: Record<MonitoringThresholdRow['source'], string> = {
  DEFAULT: 'Padrão do produto',
  GLOBAL: 'Global',
  COMPANY: 'Empresa',
  BRANCH: 'Filial',
};

type Branch = { id: string; name: string };

/**
 * Limites do monitoramento (Super Admin): global, da empresa ou de uma filial — o mais específico vence. Cada métrica
 * tem uma faixa permitida (o teto impede esconder um problema com um limite alto demais). Toda alteração exige motivo
 * e fica no histórico.
 */
export default function ThresholdsPage() {
  const { id } = useParams<{ id: string }>();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [scopeKey, setScopeKey] = useState<string>('company');
  const [rows, setRows] = useState<MonitoringThresholdRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { attention: string; critical: string }>>({});
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const scope: ThresholdScope =
    scopeKey === 'global' ? {} : scopeKey === 'company' ? { companyId: id } : { companyId: id, branchId: scopeKey };
  const scopeSource: MonitoringThresholdRow['source'] = scopeKey === 'global' ? 'GLOBAL' : scopeKey === 'company' ? 'COMPANY' : 'BRANCH';

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, h] = await Promise.all([monitoringApi.thresholds(scope), monitoringApi.thresholdHistory(id)]);
      const metrics: MonitoringThresholdRow[] = t.data.metrics ?? [];
      setRows(metrics);
      setDrafts(Object.fromEntries(metrics.map((m) => [m.metric, { attention: String(m.attention), critical: String(m.critical) }])));
      setHistory(h.data.changes ?? []);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar os limites.'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, scopeKey]);

  useEffect(() => {
    api
      .get('/branches', { params: { companyId: id } })
      .then((r) => setBranches((r.data?.data ?? []).map((b: any) => ({ id: b.id, name: b.name }))))
      .catch(() => setBranches([]));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (row: MonitoringThresholdRow) => {
    const draft = drafts[row.metric];
    setNotice(null);
    setSaving(row.metric);
    try {
      await monitoringApi.setThreshold(scope, { metric: row.metric, attention: Number(draft.attention), critical: Number(draft.critical), reason });
      setNotice({ kind: 'ok', text: `${row.label}: limite salvo.` });
      await load();
    } catch (err: any) {
      setNotice({ kind: 'error', text: apiErrorMessage(err?.response?.data, 'Não foi possível salvar o limite.') });
    } finally {
      setSaving(null);
    }
  };

  const reset = async (row: MonitoringThresholdRow) => {
    setNotice(null);
    setSaving(row.metric);
    try {
      await monitoringApi.resetThreshold(scope, { metric: row.metric, reason });
      setNotice({ kind: 'ok', text: `${row.label}: ajuste removido; vale o limite do escopo acima.` });
      await load();
    } catch (err: any) {
      setNotice({ kind: 'error', text: apiErrorMessage(err?.response?.data, 'Não foi possível remover o ajuste.') });
    } finally {
      setSaving(null);
    }
  };

  const branchName = (branchId: string | null) => (branchId ? branches.find((b) => b.id === branchId)?.name ?? 'filial' : null);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/dashboard/companies/${id}/health`} aria-label="Voltar para a saúde da empresa">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Limites do monitoramento</h1>
          <p className="text-sm text-muted-foreground">O limite mais específico vence: filial → empresa → global → padrão do produto.</p>
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="scope">Escopo</Label>
            <select
              id="scope"
              value={scopeKey}
              onChange={(e) => setScopeKey(e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="global">Global (todas as empresas)</option>
              <option value="company">Esta empresa</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  Filial: {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reason">Motivo da alteração (obrigatório)</Label>
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: filial com servidor mais antigo" />
          </div>
          {notice && (
            <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`text-sm sm:col-span-2 ${notice.kind === 'error' ? 'text-destructive' : 'text-foreground'}`}>
              {notice.text}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Métricas</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Métrica</th>
                <th className="py-2 pr-4 font-medium">Atenção</th>
                <th className="py-2 pr-4 font-medium">Crítico</th>
                <th className="py-2 pr-4 font-medium">Vem de</th>
                <th className="py-2 pr-4 font-medium">Faixa permitida</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.metric} className="border-b border-border last:border-0">
                  <td className="py-2 pr-4 text-foreground">
                    {row.label}
                    <span className="block text-xs text-muted-foreground">em {row.unit}</span>
                  </td>
                  {(['attention', 'critical'] as const).map((field) => (
                    <td key={field} className="py-2 pr-4">
                      <Input
                        aria-label={`${row.label} — ${field === 'attention' ? 'atenção' : 'crítico'}`}
                        type="number"
                        inputMode="decimal"
                        className="w-28"
                        value={drafts[row.metric]?.[field] ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [row.metric]: { ...d[row.metric], [field]: e.target.value } }))}
                      />
                    </td>
                  ))}
                  <td className="py-2 pr-4 text-foreground">{SOURCE_LABEL[row.source]}</td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    atenção ≥ {row.bounds.min} · crítico ≤ {row.bounds.max}
                  </td>
                  <td className="space-x-2 whitespace-nowrap py-2">
                    <Button size="sm" onClick={() => save(row)} disabled={saving === row.metric}>
                      Salvar
                    </Button>
                    {row.source === scopeSource && (
                      <Button size="sm" variant="outline" onClick={() => reset(row)} disabled={saving === row.metric}>
                        Remover ajuste
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Histórico de alterações</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma alteração registrada.</p>
          ) : (
            <ul className="divide-y divide-border">
              {history.map((c) => {
                const label = rows.find((r) => r.metric === c.metric)?.label ?? c.metric;
                const where = c.companyId ? branchName(c.branchId) ?? 'empresa' : 'global';
                const fmt = (a: number | null, k: number | null) => (a === null || k === null ? 'padrão/herdado' : `${a} / ${k}`);
                return (
                  <li key={c.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                    <span className="text-foreground">
                      {label} ({where}): {fmt(c.oldAttention, c.oldCritical)} → {fmt(c.newAttention, c.newCritical)}
                      <span className="block text-muted-foreground">Motivo: {c.reason}</span>
                    </span>
                    <span className="text-muted-foreground">{new Date(c.changedAt).toLocaleString('pt-BR')}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
