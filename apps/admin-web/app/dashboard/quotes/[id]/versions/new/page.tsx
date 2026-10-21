'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QuoteItemsEditor } from '@/components/quotes/QuoteItemsEditor';
import { QuoteStatusBadge } from '@/components/quotes/QuoteStatusBadge';
import { QuoteTotals } from '@/components/quotes/QuoteTotals';
import { api, getCurrentUserClaims } from '@/lib/api';
import {
  canWriteQuotes,
  computeQuoteTotals,
  latestVersion,
  newItemDraft,
  quoteActions,
  validateItemDrafts,
  type QuoteItemDraft,
  type QuoteItemType,
} from '@/lib/quotes';

interface VersionItem {
  itemType: QuoteItemType;
  productId?: string | null;
  description: string;
  quantity: number | string;
  unitPrice: number | string;
}

interface QuoteForVersion {
  id: string;
  quoteNumber: number;
  status: string;
  customer?: { name: string } | null;
  motorcycle?: { brand: string; model: string; licensePlate?: string | null } | null;
  versions: Array<{
    versionNumber: number;
    sentAt?: string | null;
    isApproved?: boolean;
    approvedAt?: string | null;
    items: VersionItem[];
  }>;
}

export default function NewQuoteVersionPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const quoteId = params?.id;

  const [canWrite, setCanWrite] = useState(false);
  const [quote, setQuote] = useState<QuoteForVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'not-found' | 'generic' | null>(null);
  const [items, setItems] = useState<QuoteItemDraft[]>([]);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCanWrite(canWriteQuotes(getCurrentUserClaims()?.userType));
  }, []);

  useEffect(() => {
    if (!quoteId) return;
    let cancelled = false;
    setLoading(true);
    api
      .getQuote(quoteId)
      .then((data: QuoteForVersion) => {
        if (cancelled) return;
        setQuote(data);
        // A nova versão parte dos itens da versão vigente: o usuário ajusta
        // em vez de redigitar o orçamento inteiro.
        const current = latestVersion(data.versions);
        setItems(
          (current?.items ?? []).map((item) =>
            newItemDraft(item.itemType, {
              productId: item.productId ?? undefined,
              description: item.description,
              quantity: String(Number(item.quantity)),
              unitPrice: String(Number(item.unitPrice)),
            })
          )
        );
      })
      .catch((err: any) => {
        if (!cancelled) setLoadError(err?.response?.status === 404 ? 'not-found' : 'generic');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [quoteId]);

  const totals = useMemo(
    () =>
      computeQuoteTotals(
        items.map((item) => ({
          itemType: item.itemType,
          quantity: Number(String(item.quantity).replace(',', '.')) || 0,
          unitPrice: Number(String(item.unitPrice).replace(',', '.')) || 0,
        }))
      ),
    [items]
  );

  // O aviso de erro some assim que o usuário edita os itens.
  useEffect(() => {
    setFormError(null);
  }, [items]);

  const allowed = quote ? quoteActions(quote, canWrite).canAddVersion : false;
  const backHref = quoteId ? `/dashboard/quotes/${quoteId}` : '/dashboard/quotes';

  async function handleSave() {
    if (!quote) return;
    setFormError(null);
    setItemErrors({});

    const validation = validateItemDrafts(items);
    if (validation.message) {
      setItemErrors(validation.errors);
      return setFormError(validation.message);
    }

    setSaving(true);
    try {
      await api.addQuoteVersion(quote.id, { items: validation.payload });
      router.push(`/dashboard/quotes/${quote.id}`);
    } catch (err: any) {
      setFormError(err?.response?.data?.error || 'Não foi possível salvar a nova versão. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="Carregando orçamento">
        <div className="h-9 w-64 animate-pulse rounded bg-muted" />
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
          <Link href="/dashboard/quotes">
            <Button variant="outline">Voltar para orçamentos</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const nextVersion = (latestVersion(quote.versions)?.versionNumber ?? 0) + 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={backHref} aria-label="Voltar para o orçamento">
          <Button variant="ghost" size="sm" type="button">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
        </Link>
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold text-foreground">
              Nova versão — orçamento #{quote.quoteNumber}
            </h1>
            <QuoteStatusBadge status={quote.status} />
          </div>
          <p className="mt-1 text-muted-foreground">
            {quote.customer?.name ?? '—'}
            {quote.motorcycle
              ? ` · ${quote.motorcycle.brand} ${quote.motorcycle.model}${quote.motorcycle.licensePlate ? ` · ${quote.motorcycle.licensePlate}` : ''}`
              : ''}
          </p>
        </div>
      </div>

      {!canWrite ? (
        <Alert variant="warning" data-testid="no-permission">
          <AlertTitle>Sem permissão para alterar orçamentos</AlertTitle>
          <AlertDescription>O seu perfil só pode consultar orçamentos.</AlertDescription>
        </Alert>
      ) : !allowed ? (
        <Alert variant="warning" data-testid="version-blocked">
          <AlertTitle>Este orçamento não aceita nova versão</AlertTitle>
          <AlertDescription>
            {quote.status === 'CONVERTED'
              ? 'Ele já virou Ordem de Serviço.'
              : 'A versão aprovada já está pronta para virar Ordem de Serviço. Converta-a ou peça um novo orçamento.'}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Alert variant="default" data-testid="version-hint">
              <AlertDescription>
                Você está criando a versão {nextVersion}, partindo dos itens da versão atual. Ao salvar, o orçamento volta para
                “Rascunho” e precisa ser enviado ao cliente de novo.
              </AlertDescription>
            </Alert>

            {formError && (
              <Alert variant="destructive" data-testid="form-error">
                <AlertTitle>Não foi possível salvar</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Itens e serviços</CardTitle>
              </CardHeader>
              <CardContent>
                <QuoteItemsEditor items={items} onChange={setItems} errors={itemErrors} />
              </CardContent>
            </Card>
          </div>

          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <QuoteTotals totals={totals} title={`Valores — versão ${nextVersion}`} />
            <div className="flex flex-col gap-2">
              <Button type="button" onClick={handleSave} disabled={saving} data-testid="save-version">
                <Save className="mr-2 h-4 w-4" aria-hidden />
                {saving ? 'Salvando...' : 'Salvar nova versão'}
              </Button>
              <Link href={backHref} className="w-full">
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
