'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CategoryBarChart } from '@/components/charts/CategoryBarChart';
import { api } from '@/lib/api';
import { DEFAULT_PERIOD_SELECTION, count, money, periodParams, type ManagementSummary, type ManagementTimeseries, type PeriodSelection } from '@/lib/dashboard-management';
import { PeriodPicker } from './PeriodPicker';
import { ManagementKpis } from './ManagementKpis';
import { PaymentMethodsPanel } from './PaymentMethodsPanel';
import { CashPanel, EvolutionCard, OriginPanel } from './ManagementCharts';

// Painel gerencial do Administrador e do Gerente. UM período (o seletor) controla TUDO: resumo, séries e OS. Duas chamadas
// gerenciais (resumo e séries, ambas com o mesmo nome de recorte; a API resolve o intervalo em Brasília) e, depois delas e em
// sequência, as três consultas operacionais (financeiro, estoque, oficina): nunca uma rajada de chamadas ao abrir (decisão 57).
// A autoridade é a API: o gerente é limitado à própria filial lá, e esconder o seletor de filial aqui é só apresentação.

type Fetch<T> = { data: T | null; loading: boolean; error: string | null };
const idle = <T,>(): Fetch<T> => ({ data: null, loading: true, error: null });
const dayText = (d: string) => d.split('-').reverse().join('/'); // só texto AAAA-MM-DD → DD/MM/AAAA

function messageOf(err: any, fallback: string): string {
  return err?.response?.data?.error || err?.response?.data?.message || fallback;
}

export function ManagementDashboard({ userType }: { userType: 'COMPANY_ADMIN' | 'MANAGER' }) {
  const isAdmin = userType === 'COMPANY_ADMIN';
  const [selection, setSelection] = useState<PeriodSelection>(DEFAULT_PERIOD_SELECTION);
  const [compare, setCompare] = useState(true);
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);

  const [summary, setSummary] = useState<Fetch<ManagementSummary>>(idle());
  const [series, setSeries] = useState<Fetch<ManagementTimeseries>>(idle());
  const [stock, setStock] = useState<Fetch<any>>(idle());
  const run = useRef(0); // descarta resposta de um pedido que já foi substituído por outro período/filial
  const opsFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .getBranches()
      .then((r: any) => setBranches((r?.data ?? []).map((b: any) => ({ id: b.id, name: b.name }))))
      .catch(() => setBranches([]));
  }, [isAdmin]);

  const load = useCallback(async () => {
    const mine = ++run.current;
    const params = { ...periodParams(selection), ...(isAdmin && branchId ? { branchId } : {}) };
    setSummary((s) => ({ ...s, loading: true, error: null }));
    setSeries((s) => ({ ...s, loading: true, error: null }));
    const [sum, ser] = await Promise.allSettled([api.getManagementSummary(params), api.getManagementTimeseries(params)]);
    if (mine !== run.current) return;
    setSummary(sum.status === 'fulfilled' ? { data: sum.value, loading: false, error: null } : { data: null, loading: false, error: messageOf((sum as PromiseRejectedResult).reason, 'Não foi possível carregar os indicadores do período.') });
    setSeries(ser.status === 'fulfilled' ? { data: ser.value, loading: false, error: null } : { data: null, loading: false, error: messageOf((ser as PromiseRejectedResult).reason, 'Não foi possível carregar os gráficos do período.') });

    // Estoque (valor a custo fica fora; só contagens) não depende do período e tem cache no servidor: uma chamada depois do essencial,
    // e só recarrega se a filial mudou. Contas vencidas e OS já vêm no resumo (`operations`): nenhuma chamada extra.
    const opsKey = isAdmin ? branchId || 'all' : 'mine';
    if (opsFor.current !== opsKey) {
      opsFor.current = opsKey;
      setStock((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await api.getStockDashboard(isAdmin && branchId ? { branchId } : {});
        if (mine === run.current) setStock({ data, loading: false, error: null });
      } catch {
        if (mine === run.current) setStock({ data: null, loading: false, error: 'Não foi possível carregar o estoque.' });
      }
    }
  }, [selection, branchId, isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const period = summary.data?.period ?? series.data?.period ?? null;
  const showBranches = isAdmin && !branchId && (summary.data?.byBranch.length ?? 0) > 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {period ? (
              compare ? (
                <>
                  Comparado a <span className="font-medium text-foreground">{period.previous.label}</span> (
                  {period.previous.startDay === period.previous.endDay ? dayText(period.previous.startDay) : `${dayText(period.previous.startDay)} – ${dayText(period.previous.endDay)}`})
                </>
              ) : (
                'Sem comparação com o período anterior'
              )
            ) : summary.loading || series.loading ? (
              'Carregando período…'
            ) : (
              'Período indisponível' // as duas chamadas falharam: não dizer "carregando" para sempre
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodPicker value={selection} rangeLabel={period?.rangeLabel} onChange={setSelection} />
          <button
            type="button"
            aria-pressed={compare}
            onClick={() => setCompare((c) => !c)}
            className={`h-9 rounded-md border px-3 text-sm transition-colors ${compare ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted'}`}
          >
            Comparar com o período anterior
          </button>
          {isAdmin && branches.length > 1 && (
            <label className="sr-only" htmlFor="dash-branch">
              Filial
            </label>
          )}
          {isAdmin && branches.length > 1 && (
            <select id="dash-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground">
              <option value="">Todas as filiais</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => {
              opsFor.current = null; // atualizar de propósito recarrega também a faixa de operação
              load();
            }}
            aria-label="Atualizar painel"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {summary.error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-sm text-danger">{summary.error}</p>
            <Button variant="outline" size="sm" onClick={() => load()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ManagementKpis summary={summary.data} loading={summary.loading} compare={compare} />
      )}

      {/* Evolução e origem à esquerda, formas de pagamento (mais alto) à direita; no celular a ordem é evolução, pagamentos, origem. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 lg:col-start-1 lg:row-start-1">
          <EvolutionCard series={series.data} loading={series.loading} error={series.error} compare={compare} onRetry={() => load()} />
        </div>
        <div className="lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <PaymentMethodsPanel summary={summary.data} loading={summary.loading} error={summary.error} compare={compare} onRetry={() => load()} />
        </div>
        <div className="lg:col-span-2 lg:col-start-1 lg:row-start-2">
          <OriginPanel summary={summary.data} series={series.data} loading={summary.loading || series.loading} error={summary.error ?? series.error} onRetry={() => load()} />
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-6 ${showBranches ? 'lg:grid-cols-2' : ''}`}>
        <CashPanel summary={summary.data} series={series.data} loading={summary.loading || series.loading} error={summary.error ?? series.error} onRetry={() => load()} />
        {showBranches && summary.data && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Receita por filial</CardTitle>
            </CardHeader>
            <CardContent>
              <CategoryBarChart data={summary.data.byBranch.map((b) => ({ name: b.branchName, value: b.revenue }))} height={240} seriesLabel="Receita" />
            </CardContent>
          </Card>
        )}
      </div>

      <Operations summary={summary} stock={stock} />
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: 'danger' | 'warning'; hint?: string }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {tone && <span aria-hidden className={`h-2 w-2 rounded-full ${tone === 'danger' ? 'bg-danger' : 'bg-warning'}`} />}
        {label}
      </p>
      <p className="text-lg font-semibold text-foreground">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// Faixa compacta com o que já existia (oficina, estoque e contas): sem gráfico, só o que pede atenção.
function Operations({ summary, stock }: { summary: Fetch<ManagementSummary>; stock: Fetch<any> }) {
  const ops = summary.data?.operations;
  const wait = (f: Fetch<any>) => f.loading;
  // nulo = módulo (Financeiro ou Oficina) desligado para a filial: "—", nunca zero
  const num = (v: number | null | undefined) => (summary.loading ? '…' : summary.error || v === null || v === undefined ? '—' : count(v));
  const cur = (v: number | null | undefined) => (summary.loading ? '…' : summary.error || v === null || v === undefined ? '—' : money(v));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Operação</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="OS em aberto" value={num(ops?.openOrders)} />
          <Stat label="OS atrasadas" tone="danger" value={num(ops?.overdueOrders)} />
          <Stat
            label="Estoque baixo"
            tone="warning"
            value={wait(stock) ? '…' : stock.error ? '—' : count(stock.data?.lowStockCount ?? 0)}
            hint={stock.data ? `de ${count(stock.data.activeProductsCount)} produtos` : undefined}
          />
          <Stat label="Estoque sem inventário" value={wait(stock) ? '…' : stock.error ? '—' : count(stock.data?.notInventoriedCount ?? 0)} />
          <Stat label="A pagar vencidas" tone="danger" value={cur(ops?.payablesOverdue)} />
          <Stat label="A receber vencidas" tone="danger" value={cur(ops?.receivablesOverdue)} />
        </div>
        {stock.error && <p className="mt-3 text-xs text-danger">{stock.error}</p>}
      </CardContent>
    </Card>
  );
}
