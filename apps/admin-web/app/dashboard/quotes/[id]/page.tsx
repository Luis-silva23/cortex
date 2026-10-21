'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, CheckCircle2, ClipboardList, FilePlus2, History, RefreshCw, RotateCcw, Send, Wrench } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { QuoteStatusBadge } from '@/components/quotes/QuoteStatusBadge';
import { QuoteStepper } from '@/components/quotes/QuoteStepper';
import { QuoteTotals } from '@/components/quotes/QuoteTotals';
import { api, getCurrentUserClaims } from '@/lib/api';
import { openQuoteConflict, quotesApi } from '@/lib/api/quotes';
import { cn } from '@/lib/cn';
import {
  ITEM_TYPE_LABEL,
  QUOTE_EVENT_LABEL,
  REOPEN_REASON_MIN,
  overdueLabel,
  canWriteQuotes,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatQuantity,
  isPastValidity,
  latestVersion,
  quoteActions,
  type QuoteItemType,
} from '@/lib/quotes';

interface QuoteItem {
  id: string;
  itemType: QuoteItemType;
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  totalPrice: number | string;
}

interface QuoteVersion {
  id: string;
  versionNumber: number;
  laborTotal: number | string;
  partsTotal: number | string;
  discountAmount: number | string;
  totalAmount: number | string;
  sentAt?: string | null;
  isApproved?: boolean;
  approvedAt?: string | null;
  decisionNotes?: string | null;
  items: QuoteItem[];
  serviceOrder?: { id: string; osNumber: number; status: string } | null;
}

interface QuoteDetail {
  id: string;
  quoteNumber: number;
  status: string;
  branchId: string;
  validUntil?: string | null;
  notes?: string | null;
  createdAt: string;
  customer?: { id: string; name: string; phone?: string | null; mobile?: string | null; document?: string | null; email?: string | null } | null;
  motorcycle?: {
    id: string;
    brand: string;
    model: string;
    licensePlate?: string | null;
    year?: number | null;
    color?: string | null;
    kilometerReading?: number | string | null;
  } | null;
  versions: QuoteVersion[];
  closedAt?: string | null;
  closeReason?: string | null;
  overdue?: boolean;
  respondBy?: string | null;
  daysWithoutResponse?: number | null;
  expirationDays?: number;
  reopenAllowed?: boolean;
  events?: Array<{ id: string; eventType: string; fromStatus: string | null; toStatus: string | null; reason: string | null; performedBy: string; createdAt: string }>;
}

function versionState(version: QuoteVersion): string {
  if (version.approvedAt) return version.isApproved ? 'Aprovada' : 'Recusada';
  if (version.sentAt) return 'Enviada';
  return 'Rascunho';
}

function apiError(err: any, fallback: string): string {
  return err?.response?.data?.error || fallback;
}

export default function QuoteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const quoteId = params?.id;

  const [canWrite, setCanWrite] = useState(false);
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'not-found' | 'generic' | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decisionApproved, setDecisionApproved] = useState(true);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const [convertOpen, setConvertOpen] = useState(false);
  const [entryKilometer, setEntryKilometer] = useState('');
  const [fuelLevel, setFuelLevel] = useState('');
  const [visibleDamages, setVisibleDamages] = useState('');
  const [personalItems, setPersonalItems] = useState('');
  const [entryNotes, setEntryNotes] = useState('');
  const [convertError, setConvertError] = useState<string | null>(null);

  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopenConflict, setReopenConflict] = useState<{ id: string; number: number } | null>(null);

  useEffect(() => {
    setCanWrite(canWriteQuotes(getCurrentUserClaims()?.userType));
  }, []);

  const load = useCallback(async () => {
    if (!quoteId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data: QuoteDetail = await api.getQuote(quoteId);
      setQuote(data);
      setSelectedVersion((current) => current ?? latestVersion(data.versions)?.versionNumber ?? null);
    } catch (err: any) {
      setLoadError(err?.response?.status === 404 ? 'not-found' : 'generic');
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => {
    load();
  }, [load]);

  const latest = useMemo(() => latestVersion(quote?.versions), [quote]);
  const shown = useMemo(
    () => quote?.versions.find((v) => v.versionNumber === selectedVersion) ?? latest,
    [quote, selectedVersion, latest]
  );
  const actions = useMemo(() => (quote ? quoteActions(quote, canWrite) : null), [quote, canWrite]);

  async function refreshAfterAction(message: string) {
    setNotice(message);
    setSelectedVersion(null);
    await load();
  }

  async function handleSend() {
    if (!quote || !latest) return;
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      await api.sendQuote(quote.id, latest.versionNumber);
      await refreshAfterAction('Orçamento enviado para aprovação. Agora aguarda a decisão do cliente.');
    } catch (err: any) {
      setActionError(apiError(err, 'Não foi possível enviar o orçamento.'));
    } finally {
      setBusy(false);
    }
  }

  function openDecision() {
    setDecisionApproved(true);
    setDecisionNotes('');
    setDecisionError(null);
    setDecisionOpen(true);
  }

  async function handleDecide() {
    if (!quote || !latest) return;
    setBusy(true);
    setDecisionError(null);
    try {
      await api.decideQuote(quote.id, {
        versionNumber: latest.versionNumber,
        approved: decisionApproved,
        decisionNotes: decisionNotes.trim() || undefined,
      });
      setDecisionOpen(false);
      await refreshAfterAction(
        decisionApproved
          ? 'Aprovação do cliente registrada. O orçamento já pode virar Ordem de Serviço.'
          : 'Recusa do cliente registrada.'
      );
    } catch (err: any) {
      setDecisionError(apiError(err, 'Não foi possível registrar a decisão.'));
    } finally {
      setBusy(false);
    }
  }

  function openConvert() {
    const km = quote?.motorcycle?.kilometerReading;
    setEntryKilometer(km != null ? String(Number(km)) : '');
    setFuelLevel('');
    setVisibleDamages('');
    setPersonalItems('');
    setEntryNotes('');
    setConvertError(null);
    setConvertOpen(true);
  }

  async function handleConvert() {
    if (!quote) return;
    const km = Number(String(entryKilometer).replace(',', '.'));
    if (entryKilometer.trim() === '' || !Number.isFinite(km) || km < 0) {
      setConvertError('Informe a quilometragem de entrada (0 ou mais).');
      return;
    }
    setBusy(true);
    setConvertError(null);
    try {
      const serviceOrder = await api.convertQuoteToServiceOrder(quote.id, {
        branchId: quote.branchId,
        entryKilometer: km,
        fuelLevel: fuelLevel.trim() || undefined,
        visibleDamages: visibleDamages.trim() || undefined,
        personalItems: personalItems.trim() || undefined,
        entryNotes: entryNotes.trim() || undefined,
      });
      setConvertOpen(false);
      if (serviceOrder?.id) {
        router.push(`/dashboard/service-orders/${serviceOrder.id}`);
      } else {
        await refreshAfterAction('Ordem de Serviço gerada a partir do orçamento.');
      }
    } catch (err: any) {
      setConvertError(apiError(err, 'Não foi possível converter o orçamento em OS.'));
    } finally {
      setBusy(false);
    }
  }

  function openReopen() {
    setReopenReason('');
    setReopenError(null);
    setReopenConflict(null);
    setReopenOpen(true);
  }

  async function handleReopen() {
    if (!quote) return;
    if (reopenReason.trim().length < REOPEN_REASON_MIN) {
      setReopenError(`Informe o motivo (mínimo ${REOPEN_REASON_MIN} caracteres).`);
      return;
    }
    setBusy(true);
    setReopenError(null);
    setReopenConflict(null);
    try {
      const reopened = await quotesApi.reopen(quote.id, reopenReason.trim());
      setReopenOpen(false);
      await refreshAfterAction(
        reopened?.status === 'SENT'
          ? 'Orçamento reaberto: voltou a aguardar a aprovação do cliente.'
          : 'Orçamento reaberto como rascunho: envie ao cliente para seguir.'
      );
    } catch (err: any) {
      const conflict = openQuoteConflict(err);
      if (conflict) setReopenConflict({ id: conflict.existingQuoteId, number: conflict.existingQuoteNumber });
      setReopenError(apiError(err, 'Não foi possível reabrir o orçamento.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !quote) {
    return (
      <div className="space-y-4" role="status" aria-label="Carregando orçamento">
        <div className="h-9 w-64 animate-pulse rounded bg-muted" />
        <div className="h-10 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (loadError || !quote) {
    return (
      <Card>
        <CardContent className="p-12 text-center" data-testid="quote-load-error">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" aria-hidden />
          <h2 className="mb-2 text-lg font-medium text-foreground">
            {loadError === 'not-found' ? 'Orçamento não encontrado' : 'Não foi possível carregar o orçamento'}
          </h2>
          <p className="mb-4 text-muted-foreground">
            {loadError === 'not-found'
              ? 'Ele não existe ou pertence a outra empresa.'
              : 'Verifique a conexão e tente novamente.'}
          </p>
          <div className="flex justify-center gap-2">
            <Link href="/dashboard/quotes">
              <Button variant="outline">Voltar para orçamentos</Button>
            </Link>
            {loadError !== 'not-found' && (
              <Button onClick={load}>
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
                Tentar novamente
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const expired = isPastValidity(quote);
  const linkedOs = actions?.linkedServiceOrder ?? null;
  const shownTotals = {
    laborTotal: Number(shown?.laborTotal ?? 0),
    partsTotal: Number(shown?.partsTotal ?? 0),
    discountAmount: Number(shown?.discountAmount ?? 0),
    totalAmount: Number(shown?.totalAmount ?? 0),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <Link href="/dashboard/quotes" aria-label="Voltar para orçamentos">
            <Button variant="ghost" size="sm" type="button">
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </Button>
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold text-foreground" data-testid="quote-title">
                Orçamento #{quote.quoteNumber}
              </h1>
              <QuoteStatusBadge status={quote.status} />
            </div>
            <p className="mt-1 text-muted-foreground">
              Criado em {formatDate(quote.createdAt)} · Validade{' '}
              <span className={cn(expired && 'font-medium text-warning')}>
                {formatDate(quote.validUntil)}
                {expired && ' (vencida)'}
              </span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {actions?.canSend && (
            <Button onClick={handleSend} disabled={busy} data-testid="action-send">
              <Send className="mr-2 h-4 w-4" aria-hidden />
              Enviar para aprovação
            </Button>
          )}
          {actions?.canDecide && (
            <Button onClick={openDecision} disabled={busy} data-testid="action-decide">
              <ClipboardList className="mr-2 h-4 w-4" aria-hidden />
              Registrar decisão do cliente
            </Button>
          )}
          {actions?.canConvert && (
            <Button onClick={openConvert} disabled={busy} data-testid="action-convert">
              <Wrench className="mr-2 h-4 w-4" aria-hidden />
              Converter em OS
            </Button>
          )}
          {actions?.canAddVersion && (
            <Link href={`/dashboard/quotes/${quote.id}/versions/new`}>
              <Button variant="outline" data-testid="action-new-version">
                <FilePlus2 className="mr-2 h-4 w-4" aria-hidden />
                Nova versão
              </Button>
            </Link>
          )}
          {canWrite && quote.status === 'EXPIRED' && quote.reopenAllowed && (
            <Button onClick={openReopen} disabled={busy} data-testid="action-reopen">
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden />
              Reabrir orçamento
            </Button>
          )}
          {linkedOs && (
            <Link href={`/dashboard/service-orders/${linkedOs.id}`}>
              <Button variant="outline" data-testid="link-service-order">
                <Wrench className="mr-2 h-4 w-4" aria-hidden />
                Ver OS #{linkedOs.osNumber}
              </Button>
            </Link>
          )}
        </div>
      </div>

      {notice && (
        <Alert variant="success" data-testid="action-notice">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive" data-testid="action-error">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Ação não concluída</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {quote.status === 'EXPIRED' && (
        <Alert variant="warning" data-testid="closed-notice">
          <AlertTitle>Orçamento encerrado{quote.closedAt ? ` em ${formatDateTime(quote.closedAt)}` : ''}</AlertTitle>
          <AlertDescription>
            {quote.closeReason ? `Motivo: ${quote.closeReason}. ` : ''}
            {quote.reopenAllowed
              ? 'Se o cliente voltou, reabra para seguir com a aprovação e a ordem de serviço.'
              : 'A política da empresa não permite reabrir: crie um novo orçamento.'}
          </AlertDescription>
        </Alert>
      )}
      {quote.overdue && (
        <Alert variant="warning" data-testid="overdue-notice">
          <AlertTitle>{overdueLabel(quote)}</AlertTitle>
          <AlertDescription>
            O prazo de resposta ({quote.expirationDays} dias) passou. O orçamento pode ser encerrado na lista de orçamentos.
          </AlertDescription>
        </Alert>
      )}
      {!canWrite && (
        <Alert variant="warning" data-testid="read-only-notice">
          <AlertDescription>O seu perfil só consulta orçamentos: as ações de envio, decisão e conversão ficam ocultas.</AlertDescription>
        </Alert>
      )}
      {actions?.canSend && (
        <p className="text-sm text-muted-foreground">
          “Enviar para aprovação” registra o envio no sistema — o aviso ao cliente (WhatsApp, telefone, e-mail) é feito por você.
        </p>
      )}

      <Card>
        <CardContent className="p-4 sm:p-6">
          <QuoteStepper status={quote.status} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Cliente e veículo</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Cliente</p>
                <p className="mt-1 font-medium text-foreground" data-testid="quote-customer">
                  {quote.customer?.name ?? '—'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {[quote.customer?.phone || quote.customer?.mobile, quote.customer?.document, quote.customer?.email]
                    .filter(Boolean)
                    .join(' · ') || 'Sem contato cadastrado'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Veículo</p>
                <p className="mt-1 font-medium text-foreground" data-testid="quote-motorcycle">
                  {quote.motorcycle ? `${quote.motorcycle.brand} ${quote.motorcycle.model}` : '—'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {[
                    quote.motorcycle?.licensePlate,
                    quote.motorcycle?.year,
                    quote.motorcycle?.color,
                    quote.motorcycle?.kilometerReading != null
                      ? `${Number(quote.motorcycle.kilometerReading).toLocaleString('pt-BR')} km`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Sem dados adicionais'}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="text-lg">
                Itens e serviços{shown ? ` — versão ${shown.versionNumber}` : ''}
              </CardTitle>
              {quote.versions.length > 1 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Versões do orçamento">
                  {quote.versions.map((version) => {
                    const active = shown?.versionNumber === version.versionNumber;
                    return (
                      <button
                        key={version.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelectedVersion(version.versionNumber)}
                        data-testid={`version-tab-${version.versionNumber}`}
                        className={cn(
                          'rounded-md border px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active ? 'border-foreground bg-accent font-medium text-foreground' : 'border-border text-muted-foreground hover:bg-accent'
                        )}
                      >
                        v{version.versionNumber}
                      </button>
                    );
                  })}
                </div>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {!shown || shown.items.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">Esta versão não tem itens.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Descrição</TableHead>
                      <TableHead className="text-right">Qtd.</TableHead>
                      <TableHead className="text-right">Unitário</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.items.map((item) => (
                      <TableRow key={item.id} data-testid="detail-item-row">
                        <TableCell className="text-muted-foreground">{ITEM_TYPE_LABEL[item.itemType] ?? item.itemType}</TableCell>
                        <TableCell className="font-medium">{item.description}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatQuantity(item.quantity)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(item.unitPrice)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatCurrency(item.totalPrice)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {quote.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Observações</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-foreground" data-testid="quote-notes">
                  {quote.notes}
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Histórico de versões</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3" data-testid="version-history">
                {[...quote.versions].reverse().map((version) => (
                  <li key={version.id} className="flex flex-col gap-1 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        Versão {version.versionNumber} · {versionState(version)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {version.sentAt ? `Enviada em ${formatDateTime(version.sentAt)}` : 'Ainda não enviada'}
                        {version.approvedAt ? ` · Decisão em ${formatDateTime(version.approvedAt)}` : ''}
                      </p>
                      {version.decisionNotes && (
                        <p className="mt-1 text-sm text-muted-foreground">“{version.decisionNotes}”</p>
                      )}
                    </div>
                    <p className="text-sm font-semibold tabular-nums text-foreground">{formatCurrency(version.totalAmount)}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          {quote.events && quote.events.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <History className="h-4 w-4" aria-hidden />
                  Histórico do orçamento
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3" data-testid="quote-events">
                  {quote.events.map((event) => (
                    <li key={event.id} className="rounded-lg border border-border p-3 text-sm">
                      <p className="font-medium text-foreground">{QUOTE_EVENT_LABEL[event.eventType] ?? event.eventType}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(event.createdAt)}
                        {event.performedBy === 'SYSTEM' ? ' · rotina automática' : ''}
                      </p>
                      {event.reason && <p className="mt-1 text-muted-foreground">“{event.reason}”</p>}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
          <QuoteTotals totals={shownTotals} title={shown ? `Valores — versão ${shown.versionNumber}` : 'Valores'} />
        </aside>
      </div>

      <Dialog open={reopenOpen} onOpenChange={(open) => !busy && setReopenOpen(open)}>
        <DialogContent className="max-w-md" onClose={() => !busy && setReopenOpen(false)}>
          <DialogHeader>
            <DialogTitle>Reabrir orçamento #{quote.quoteNumber}</DialogTitle>
            <DialogDescription>
              O orçamento volta a aguardar a aprovação do cliente. O encerramento anterior continua no histórico.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-6">
            <div className="space-y-1">
              <Label htmlFor="reopen-reason">Motivo da reabertura</Label>
              <Textarea
                id="reopen-reason"
                rows={3}
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="Ex.: cliente voltou com a moto e quer seguir com o serviço"
              />
            </div>
            {reopenError && (
              <Alert variant="destructive" data-testid="reopen-error">
                <AlertDescription>
                  {reopenError}
                  {reopenConflict && (
                    <>
                      {' '}
                      <Link href={`/dashboard/quotes/${reopenConflict.id}`} className="font-medium underline">
                        Abrir o orçamento #{reopenConflict.number}
                      </Link>
                    </>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenOpen(false)} disabled={busy}>
              Voltar
            </Button>
            <Button onClick={handleReopen} disabled={busy} data-testid="reopen-confirm">
              {busy ? 'Reabrindo...' : 'Reabrir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={decisionOpen} onOpenChange={(open) => !busy && setDecisionOpen(open)}>
        <DialogContent className="max-w-md" onClose={() => !busy && setDecisionOpen(false)}>
          <DialogHeader>
            <DialogTitle>Decisão do cliente</DialogTitle>
            <DialogDescription>
              Registre o que o cliente respondeu sobre a versão {latest?.versionNumber} ({formatCurrency(latest?.totalAmount)}).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-6">
            <div role="radiogroup" aria-label="Resposta do cliente" className="grid grid-cols-2 gap-2">
              {[
                { value: true, label: 'Aprovou' },
                { value: false, label: 'Recusou' },
              ].map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  role="radio"
                  aria-checked={decisionApproved === option.value}
                  data-testid={option.value ? 'decision-approve' : 'decision-reject'}
                  onClick={() => setDecisionApproved(option.value)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    decisionApproved === option.value
                      ? 'border-foreground bg-accent text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="space-y-1">
              <Label htmlFor="decision-notes">Observação (opcional)</Label>
              <Textarea
                id="decision-notes"
                rows={3}
                value={decisionNotes}
                onChange={(e) => setDecisionNotes(e.target.value)}
                placeholder="Ex.: cliente aprovou por telefone"
              />
            </div>
            {decisionError && (
              <Alert variant="destructive" data-testid="decision-error">
                <AlertDescription>{decisionError}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecisionOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={handleDecide} disabled={busy} data-testid="decision-confirm">
              {busy ? 'Registrando...' : 'Confirmar decisão'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={convertOpen} onOpenChange={(open) => !busy && setConvertOpen(open)}>
        <DialogContent className="max-w-lg" onClose={() => !busy && setConvertOpen(false)}>
          <DialogHeader>
            <DialogTitle>Converter em Ordem de Serviço</DialogTitle>
            <DialogDescription>
              A OS nasce em “Entrada” com os itens da versão aprovada. Informe o estado da moto na entrada.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="convert-km">Quilometragem de entrada</Label>
                <Input
                  id="convert-km"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  value={entryKilometer}
                  onChange={(e) => setEntryKilometer(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="convert-fuel">Nível de combustível (opcional)</Label>
                <Input id="convert-fuel" value={fuelLevel} onChange={(e) => setFuelLevel(e.target.value)} placeholder="Ex.: 1/2" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="convert-damages">Avarias visíveis (opcional)</Label>
              <Textarea id="convert-damages" rows={2} value={visibleDamages} onChange={(e) => setVisibleDamages(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="convert-personal">Pertences deixados na moto (opcional)</Label>
              <Textarea id="convert-personal" rows={2} value={personalItems} onChange={(e) => setPersonalItems(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="convert-notes">Observações de entrada (opcional)</Label>
              <Textarea id="convert-notes" rows={2} value={entryNotes} onChange={(e) => setEntryNotes(e.target.value)} />
            </div>
            {convertError && (
              <Alert variant="destructive" data-testid="convert-error">
                <AlertDescription>{convertError}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={handleConvert} disabled={busy} data-testid="convert-confirm">
              {busy ? 'Convertendo...' : 'Gerar Ordem de Serviço'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
