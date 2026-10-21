'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, History, RotateCcw, Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CustomerPicker, type CustomerOption } from '@/components/quotes/CustomerPicker';
import { MotorcyclePicker, type MotorcycleOption } from '@/components/quotes/MotorcyclePicker';
import { QuoteItemsEditor } from '@/components/quotes/QuoteItemsEditor';
import { QuoteTotals } from '@/components/quotes/QuoteTotals';
import { QuoteStatusBadge } from '@/components/quotes/QuoteStatusBadge';
import { api, getCurrentUserClaims } from '@/lib/api';
import { openQuoteConflict, quotesApi, type OpenQuoteConflict, type RelatedQuote } from '@/lib/api/quotes';
import { getApiErrorMessage } from '@/lib/errors';
import {
  REOPEN_REASON_MIN,
  canWriteQuotes,
  computeQuoteTotals,
  formatCurrency,
  formatDate,
  overdueLabel,
  endOfDayIso,
  newItemDraft,
  validateItemDrafts,
  type QuoteItemDraft,
} from '@/lib/quotes';

function todayInputValue(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default function NewQuotePage() {
  const router = useRouter();

  const [claimsLoaded, setClaimsLoaded] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [branchId, setBranchId] = useState('');
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [motorcycle, setMotorcycle] = useState<MotorcycleOption | null>(null);
  // Chave fixa no item inicial: newItemDraft() gera a chave com Date.now() e um
  // contador, o que difere entre a renderização no servidor e a hidratação
  // (mismatch em `key`/`htmlFor`). Os demais itens só nascem em eventos.
  const [items, setItems] = useState<QuoteItemDraft[]>(() => [newItemDraft('SERVICE', { key: 'item-initial' })]);
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');

  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Cliente voltou com o mesmo veículo: orçamentos existentes (abertos e encerrados recentes) antes de criar outro.
  const [related, setRelated] = useState<{ open: RelatedQuote[]; closed: RelatedQuote[] } | null>(null);
  const [reopenTarget, setReopenTarget] = useState<RelatedQuote | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [duplicate, setDuplicate] = useState<OpenQuoteConflict | null>(null);

  useEffect(() => {
    const claims = getCurrentUserClaims();
    setCanWrite(canWriteQuotes(claims?.userType));
    setClaimsLoaded(true);

    api
      .getBranches()
      .then((res) => {
        const list: Array<{ id: string; name: string }> = res?.data ?? [];
        setBranches(list);
        const preferred = claims?.branchId && list.some((b) => b.id === claims.branchId) ? claims.branchId : list[0]?.id;
        if (preferred) setBranchId(preferred);
      })
      .catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    setRelated(null);
    setReopenTarget(null);
    setDuplicate(null);
    if (!customer || !motorcycle) return;
    let cancelled = false;
    quotesApi
      .related(customer.id, motorcycle.id)
      .then((result) => !cancelled && setRelated(result))
      .catch(() => !cancelled && setRelated({ open: [], closed: [] }));
    return () => {
      cancelled = true;
    };
  }, [customer, motorcycle]);

  async function handleReopen() {
    if (!reopenTarget) return;
    if (reopenReason.trim().length < REOPEN_REASON_MIN) {
      setReopenError(`Informe o motivo (mínimo ${REOPEN_REASON_MIN} caracteres).`);
      return;
    }
    setReopening(true);
    setReopenError(null);
    try {
      await quotesApi.reopen(reopenTarget.id, reopenReason.trim());
      router.push(`/dashboard/quotes/${reopenTarget.id}`);
    } catch (err) {
      setReopenError(getApiErrorMessage(err, 'Não foi possível reabrir o orçamento.'));
    } finally {
      setReopening(false);
    }
  }

  // O aviso de erro some assim que o usuário mexe no que faltava.
  useEffect(() => {
    setFormError(null);
  }, [branchId, customer, motorcycle, items]);

  // Prévia com a mesma soma do backend (itens inválidos/em branco contam 0).
  const totals = useMemo(() => {
    const numeric = items.map((item) => ({
      itemType: item.itemType,
      quantity: Number(String(item.quantity).replace(',', '.')) || 0,
      unitPrice: Number(String(item.unitPrice).replace(',', '.')) || 0,
    }));
    return computeQuoteTotals(numeric);
  }, [items]);

  async function handleSave(confirmNew = false) {
    setFormError(null);
    setItemErrors({});
    setDuplicate(null);

    if (!branchId) return setFormError('Selecione a filial do orçamento.');
    if (!customer) return setFormError('Selecione o cliente.');
    if (!motorcycle) return setFormError('Selecione o veículo do cliente.');

    const validation = validateItemDrafts(items);
    if (validation.message) {
      setItemErrors(validation.errors);
      return setFormError(validation.message);
    }

    setSaving(true);
    try {
      const created = await quotesApi.create({
        branchId,
        customerId: customer.id,
        motorcycleId: motorcycle.id,
        validUntil: endOfDayIso(validUntil),
        notes: notes.trim() || undefined,
        items: validation.payload,
        ...(confirmNew ? { confirmNew: true } : {}),
      });
      router.push(`/dashboard/quotes/${created.id}`);
    } catch (err: any) {
      const conflict = openQuoteConflict(err);
      if (conflict) {
        setDuplicate(conflict);
        return;
      }
      setFormError(err?.response?.data?.error || 'Não foi possível salvar o orçamento. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/quotes" aria-label="Voltar para orçamentos">
          <Button variant="ghost" size="sm" type="button">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-foreground">Novo orçamento</h1>
          <p className="mt-1 text-muted-foreground">Cliente, veículo, itens e valores. Enviar ao cliente é o próximo passo.</p>
        </div>
      </div>

      {claimsLoaded && !canWrite ? (
        <Alert variant="warning" data-testid="no-permission">
          <AlertTitle>Sem permissão para criar orçamentos</AlertTitle>
          <AlertDescription>
            O seu perfil só pode consultar orçamentos. Peça a um usuário com permissão de escrita para criá-lo.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {formError && (
              <Alert variant="destructive" role="alert" data-testid="form-error">
                <AlertTitle>Não foi possível salvar</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">1. Cliente e veículo</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-1">
                  <Label htmlFor="quote-branch">Filial</Label>
                  <Select id="quote-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                    <option value="">Selecione...</option>
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </Select>
                </div>

                <CustomerPicker
                  value={customer}
                  onChange={(next) => {
                    setCustomer(next);
                    setMotorcycle(null);
                  }}
                />

                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Veículo</p>
                  <MotorcyclePicker customerId={customer?.id ?? null} value={motorcycle} onChange={setMotorcycle} />
                </div>
              </CardContent>
            </Card>

            {duplicate && (
              <Alert variant="warning" data-testid="duplicate-warning">
                <AlertTitle>Este veículo já tem um orçamento em aberto</AlertTitle>
                <AlertDescription>
                  <p>{duplicate.error}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href={`/dashboard/quotes/${duplicate.existingQuoteId}`}>
                      <Button type="button" size="sm" data-testid="duplicate-continue">
                        Continuar o orçamento #{duplicate.existingQuoteNumber}
                      </Button>
                    </Link>
                    <Button type="button" size="sm" variant="outline" onClick={() => handleSave(true)} disabled={saving} data-testid="duplicate-create-anyway">
                      Criar outro mesmo assim
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {related && (related.open.length > 0 || related.closed.length > 0) && (
              <Card data-testid="related-quotes">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <History className="h-4 w-4" aria-hidden />
                    Orçamentos existentes para este veículo
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {[...related.open, ...related.closed].map((q) => (
                    <div key={q.id} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="related-quote">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">#{q.quoteNumber}</span>
                          <QuoteStatusBadge status={q.status} />
                          {overdueLabel(q) && <span className="text-xs font-medium text-warning">{overdueLabel(q)}</span>}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {q.versions[0] ? formatCurrency(q.versions[0].totalAmount) : '—'} · criado em {formatDate(q.createdAt)}
                          {q.status === 'EXPIRED' && q.closedAt ? ` · encerrado em ${formatDate(q.closedAt)}` : ''}
                        </p>
                        {q.status === 'EXPIRED' && q.closeReason && <p className="text-xs text-muted-foreground">Motivo: {q.closeReason}</p>}
                      </div>
                      <div className="flex gap-2">
                        {q.status === 'EXPIRED' && q.canReopen ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              setReopenTarget(q);
                              setReopenReason('');
                              setReopenError(null);
                            }}
                            data-testid="related-reopen"
                          >
                            <RotateCcw className="mr-2 h-4 w-4" aria-hidden />
                            Reabrir
                          </Button>
                        ) : (
                          <Link href={`/dashboard/quotes/${q.id}`}>
                            <Button type="button" size="sm" variant={q.status === 'REJECTED' || q.status === 'EXPIRED' ? 'outline' : 'default'} data-testid="related-continue">
                              {q.status === 'REJECTED' || q.status === 'EXPIRED' ? 'Ver' : 'Continuar'}
                            </Button>
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                  {reopenTarget && (
                    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3" data-testid="related-reopen-form">
                      <Label htmlFor="related-reopen-reason">Motivo para reabrir o orçamento #{reopenTarget.quoteNumber}</Label>
                      <Textarea
                        id="related-reopen-reason"
                        rows={2}
                        value={reopenReason}
                        onChange={(e) => setReopenReason(e.target.value)}
                        placeholder="Ex.: cliente voltou e quer seguir com o serviço"
                      />
                      {reopenError && <p className="text-sm text-danger" role="alert">{reopenError}</p>}
                      <div className="flex gap-2">
                        <Button type="button" size="sm" onClick={handleReopen} disabled={reopening} data-testid="related-reopen-confirm">
                          {reopening ? 'Reabrindo...' : 'Reabrir e continuar'}
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setReopenTarget(null)} disabled={reopening}>
                          Voltar
                        </Button>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Para não duplicar, continue ou reabra um destes. Criar um novo orçamento pede confirmação quando já há um em aberto.
                  </p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">2. Itens e serviços</CardTitle>
              </CardHeader>
              <CardContent>
                <QuoteItemsEditor items={items} onChange={setItems} errors={itemErrors} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">3. Validade e observações</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1 sm:max-w-xs">
                  <Label htmlFor="quote-valid-until">Válido até (opcional)</Label>
                  <Input
                    id="quote-valid-until"
                    type="date"
                    min={todayInputValue()}
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="quote-notes">Observações (opcional)</Label>
                  <Textarea
                    id="quote-notes"
                    rows={3}
                    placeholder="Condições, prazos, informações para o cliente..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <QuoteTotals totals={totals} />
            <div className="flex flex-col gap-2">
              <Button type="button" onClick={() => handleSave()} disabled={saving} data-testid="save-quote">
                <Save className="mr-2 h-4 w-4" aria-hidden />
                {saving ? 'Salvando...' : 'Salvar orçamento'}
              </Button>
              <Link href="/dashboard/quotes" className="w-full">
                <Button type="button" variant="outline" className="w-full">
                  Cancelar
                </Button>
              </Link>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
