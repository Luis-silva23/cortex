'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { Plus, TrendingUp, TrendingDown, Wallet, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { clampPage } from '@/lib/list-pagination';
import { getApiErrorMessage } from '@/lib/errors';
import { canReverseAccount, isReversalRecord } from '@/lib/financial';

const PAGE_SIZE = 50;

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  PAID: 'Pago',
  OVERDUE: 'Vencido',
  CANCELLED: 'Cancelado',
};
const STATUS_VARIANT: Record<string, 'warning' | 'success' | 'error' | 'secondary'> = {
  PENDING: 'warning',
  PAID: 'success',
  OVERDUE: 'error',
  CANCELLED: 'secondary',
};

function formatMoney(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function FinancialPage() {
  // Os cards de fluxo de caixa eram carregados uma vez só: depois de pagar,
  // receber, criar, cancelar ou estornar uma conta os totais ficavam
  // desatualizados até recarregar a página. Cada ação bem-sucedida nos painéis
  // incrementa esta chave e o resumo recarrega.
  const [summaryRefreshKey, setSummaryRefreshKey] = useState(0);
  const refreshSummary = () => setSummaryRefreshKey((n) => n + 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Financeiro</h1>
        <p className="text-gray-500 mt-1">Contas a pagar, a receber e fluxo de caixa. Estorno é irreversível e auditado.</p>
      </div>

      <CashFlowSummary refreshKey={summaryRefreshKey} />

      <Tabs defaultValue="payables">
        <TabsList>
          <TabsTrigger value="payables">
            <TrendingDown className="h-4 w-4 mr-1 inline" /> Contas a Pagar
          </TabsTrigger>
          <TabsTrigger value="receivables">
            <TrendingUp className="h-4 w-4 mr-1 inline" /> Contas a Receber
          </TabsTrigger>
        </TabsList>
        <TabsContent value="payables">
          <AccountsPanel kind="payable" onChanged={refreshSummary} />
        </TabsContent>
        <TabsContent value="receivables">
          <AccountsPanel kind="receivable" onChanged={refreshSummary} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CashFlowSummary({ refreshKey }: { refreshKey: number }) {
  const [summary, setSummary] = useState<{ payables: { total: number; paid: number }; receivables: { total: number; paid: number }; netCashFlow: number } | null>(null);
  // ACHADO DE AUDITORIA (Agente 06): erro era engolido silenciosamente
  // (`.catch(() => setSummary(null))`, sem log nem mensagem) — os cards
  // ficavam mostrando "—" para sempre, indistinguível de "ainda
  // carregando" ou "empresa nova sem contas ainda". Sem essa correção, uma
  // falha real de rede/API nunca era percebida por quem está olhando a
  // tela financeira.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = () => {
    setLoading(true);
    setError(null);
    api
      .getCashFlowSummary()
      .then((result) => setSummary(result))
      .catch((err) => {
        console.error('Erro ao carregar resumo financeiro:', err);
        setSummary(null);
        setError('Não foi possível carregar o resumo do fluxo de caixa.');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (error) {
    return (
      <Card className="p-4 border-red-200 bg-red-50 text-sm text-red-700 flex items-center justify-between">
        <span>{error}</span>
        <Button variant="outline" size="sm" onClick={loadSummary}>
          Tentar novamente
        </Button>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Card className="p-5">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          <TrendingDown className="h-4 w-4" />
          <span className="text-sm font-medium">A Pagar (pago / total)</span>
        </div>
        <p className="text-2xl font-bold text-foreground">
          {loading && !summary ? '...' : summary ? formatMoney(summary.payables.paid) : '—'}
          <span className="text-sm text-muted-foreground font-normal"> / {loading && !summary ? '...' : summary ? formatMoney(summary.payables.total) : '—'}</span>
        </p>
      </Card>
      <Card className="p-5">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm font-medium">A Receber (recebido / total)</span>
        </div>
        <p className="text-2xl font-bold text-foreground">
          {loading && !summary ? '...' : summary ? formatMoney(summary.receivables.paid) : '—'}
          <span className="text-sm text-muted-foreground font-normal"> / {loading && !summary ? '...' : summary ? formatMoney(summary.receivables.total) : '—'}</span>
        </p>
      </Card>
      <Card className="p-5">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          <Wallet className="h-4 w-4" />
          <span className="text-sm font-medium">Fluxo de caixa líquido</span>
        </div>
        <p className="text-2xl font-bold text-foreground">
          {loading && !summary ? '...' : summary ? formatMoney(summary.netCashFlow) : '—'}
        </p>
        {summary && summary.netCashFlow < 0 && (
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-danger">
            <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
            Saldo negativo
          </p>
        )}
      </Card>
    </div>
  );
}

function AccountsPanel({ kind, onChanged }: { kind: 'payable' | 'receivable'; onChanged: () => void }) {
  const isPayable = kind === 'payable';
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  // A API devolve `pagination` e a tela descartava: acima de 50 contas, as
  // demais ficavam inacessíveis.
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{ page: number; pages: number; total: number } | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [reverseTarget, setReverseTarget] = useState<any>(null);
  const [reverseReason, setReverseReason] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = { status: statusFilter || undefined, page, limit: PAGE_SIZE };
      const result = isPayable ? await api.getPayables(params) : await api.getReceivables(params);
      // A página atual pode ter deixado de existir (ex.: a última linha dela foi
      // paga/cancelada): volta para a última página válida em vez de mostrar
      // uma tela vazia sem controle de paginação.
      const target = clampPage(page, result?.pagination?.pages);
      if (target !== page) {
        setPage(target);
        return;
      }
      setAccounts((isPayable ? result.payables : result.receivables) ?? []);
      setPagination(result?.pagination ?? null);
    } catch (err) {
      console.error('Erro ao carregar contas:', err);
      setError('Não foi possível carregar as contas. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  // Trocar o filtro volta para a página 1 (no onChange do filtro) — a página 3
  // de um filtro novo pode nem existir. Um único efeito cobre filtro e página.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, kind, page]);

  function openNew() {
    setDescription('');
    setAmount('');
    setDueDate('');
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    if (!description.trim() || !amount || Number(amount) <= 0 || !dueDate) {
      setFormError('Descrição, valor (maior que zero) e vencimento são obrigatórios');
      return;
    }
    setSaving(true);
    try {
      // ACHADO DE AUDITORIA: `dueDate` vem de <input type="date"> como uma
      // string "YYYY-MM-DD" pura — `new Date("2026-09-20")` é interpretada
      // como meia-noite UTC (regra do JS para strings de data SEM horário),
      // não meia-noite local. Para um usuário em UTC-3 (Brasil), isso é
      // 21h do dia ANTERIOR em horário local: o vencimento ficava marcado
      // OVERDUE (markOverdueAccounts compara `dueDate < now`) horas antes
      // do fim real do dia escolhido, e a própria coluna "Vencimento"
      // (linha ~311, `toLocaleDateString('pt-BR')`) exibia um dia a menos
      // do que o usuário selecionou. Construir o instante como o FIM do
      // dia LOCAL ("T23:59:59", sem sufixo de fuso — interpretado como
      // horário local pelo JS) corrige as duas pontas de uma vez, já que
      // ambas lêem o mesmo valor armazenado.
      const payload = { description, amount: Number(amount), dueDate: new Date(`${dueDate}T23:59:59`).toISOString() };
      if (isPayable) {
        await api.createPayable(payload);
      } else {
        await api.createReceivable(payload);
      }
      setDialogOpen(false);
      await load();
      onChanged();
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao criar conta'));
    } finally {
      setSaving(false);
    }
  }

  async function settle(id: string) {
    try {
      if (isPayable) {
        await api.payPayable(id);
      } else {
        await api.receiveReceivable(id);
      }
      await load();
      onChanged();
    } catch (err: any) {
      alert(getApiErrorMessage(err, 'Erro ao registrar'));
    }
  }

  async function cancelAccount(id: string) {
    const reason = window.prompt('Motivo do cancelamento (opcional):') || undefined;
    try {
      if (isPayable) {
        await api.cancelPayable(id, reason);
      } else {
        await api.cancelReceivable(id, reason);
      }
      await load();
      onChanged();
    } catch (err: any) {
      alert(getApiErrorMessage(err, 'Erro ao cancelar'));
    }
  }

  async function submitReverse() {
    if (!reverseTarget || !reverseReason.trim()) return;
    try {
      if (isPayable) {
        await api.reversePayable(reverseTarget.id, reverseReason);
      } else {
        await api.reverseReceivable(reverseTarget.id, reverseReason);
      }
      setReverseTarget(null);
      setReverseReason('');
      await load();
      onChanged();
    } catch (err: any) {
      alert(getApiErrorMessage(err, 'Erro ao estornar'));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="w-64">
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos os status</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          {isPayable ? 'Nova conta a pagar' : 'Nova conta a receber'}
        </Button>
      </div>

      <Card>
        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando...</div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
            <p className="text-gray-500 mb-4">{error}</p>
            <Button variant="outline" onClick={load}>
              Tentar novamente
            </Button>
          </div>
        ) : accounts.length === 0 ? (
          <div className="p-12 text-center text-gray-500">Nenhuma conta encontrada.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Descrição</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[260px]">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a: any) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">
                    {/* Conta a receber: detalhe com atraso e [ENVIAR COBRANÇA] (cobrança manual). */}
                    {isPayable ? (
                      a.description
                    ) : (
                      <Link className="text-primary hover:underline" href={`/dashboard/financial/receivables/${a.id}`}>
                        {a.description}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>{formatMoney(Number(a.amount))}</TableCell>
                  <TableCell>{new Date(a.dueDate).toLocaleDateString('pt-BR')}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[a.status] ?? 'secondary'}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {['PENDING', 'OVERDUE'].includes(a.status) && (
                        <>
                          <Button size="sm" onClick={() => settle(a.id)}>
                            {isPayable ? 'Pagar' : 'Receber'}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => cancelAccount(a.id)}>
                            Cancelar
                          </Button>
                        </>
                      )}
                      {canReverseAccount(a) && (
                        <Button size="sm" variant="outline" onClick={() => setReverseTarget(a)}>
                          Estornar
                        </Button>
                      )}
                      {/* O lançamento de estorno também aparece como PAID, mas
                          estornar o próprio estorno não existe (a API recusa). */}
                      {isReversalRecord(a) && (
                        <span className="text-xs text-muted-foreground">Lançamento de estorno</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!loading && !error && accounts.length > 0 && (
          <Pagination
            page={pagination?.page ?? page}
            pages={pagination?.pages ?? 1}
            total={pagination?.total ?? accounts.length}
            itemCount={accounts.length}
            onPageChange={setPage}
            itemLabel={isPayable ? 'contas a pagar' : 'contas a receber'}
          />
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isPayable ? 'Nova conta a pagar' : 'Nova conta a receber'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="space-y-1">
              <Label>Descrição</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Valor</Label>
                <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Vencimento</Label>
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!reverseTarget} onOpenChange={(open) => !open && setReverseTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Estornar &quot;{reverseTarget?.description}&quot;</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-amber-600">Ação irreversível e auditada — exige motivo.</p>
            <div className="space-y-1">
              <Label>Motivo</Label>
              <Input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={submitReverse} disabled={!reverseReason.trim()}>
              Estornar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
