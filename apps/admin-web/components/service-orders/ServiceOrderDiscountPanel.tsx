'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgePercent, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/errors';
import { policiesApi } from '@/lib/api/policies';
import {
  discountsApi,
  discountAuthorizationDetails,
  DiscountAuthorizationDetails,
  ITEM_TYPE_LABEL,
  ServiceOrderDiscountState,
} from '@/lib/api/discounts';

/**
 * Desconto da OS por tipo (peças / mão de obra), só antes do pagamento. Peças até o limite livre da política (padrão
 * 5%) sem autorização; mão de obra sem desconto livre (padrão 0%). Acima do limite a API responde 409 e o painel pede
 * o motivo e as credenciais de um gerente/administrador (outra pessoa). Todo desconto fica no histórico abaixo.
 */
const parseMoney = (v: string) => {
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);

export function ServiceOrderDiscountPanel({ serviceOrderId, onChanged }: { serviceOrderId: string; onChanged?: () => void }) {
  const [state, setState] = useState<ServiceOrderDiscountState | null>(null);
  const [limits, setLimits] = useState<{ product: number; service: number } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState('0');
  const [labor, setLabor] = useState('0');
  const [reason, setReason] = useState('');
  const [auth, setAuth] = useState({ numericId: '', password: '', mfaCode: '' });
  const [needsAuth, setNeedsAuth] = useState<DiscountAuthorizationDetails | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await discountsApi.serviceOrder(serviceOrderId));
      setLoadError('');
    } catch (err) {
      setLoadError(getApiErrorMessage(err, 'Não foi possível carregar o desconto da OS'));
    }
  }, [serviceOrderId]);

  useEffect(() => {
    load();
    policiesApi
      .effective()
      .then(({ values }) =>
        setLimits({ product: Number(values['discount.productFreePercent'] ?? 5), service: Number(values['discount.serviceFreePercent'] ?? 0) })
      )
      .catch(() => setLimits(null));
  }, [load]);

  function openDialog() {
    if (!state) return;
    setParts(state.partsDiscount.toFixed(2).replace('.', ','));
    setLabor(state.laborDiscount.toFixed(2).replace('.', ','));
    setReason('');
    setAuth({ numericId: '', password: '', mfaCode: '' });
    setNeedsAuth(null);
    setFormError('');
    setOpen(true);
  }

  async function submit() {
    if (!state) return;
    const partsDiscount = parseMoney(parts);
    const laborDiscount = parseMoney(labor);
    if (!(partsDiscount >= 0) || !(laborDiscount >= 0)) {
      setFormError('Informe valores maiores ou iguais a zero');
      return;
    }
    if (partsDiscount > state.partsTotal || laborDiscount > state.laborTotal) {
      setFormError('O desconto de cada tipo não pode passar o total daquele tipo');
      return;
    }
    if (needsAuth && (!auth.numericId || !auth.password || reason.trim().length < 5)) {
      setFormError('Informe o motivo (mínimo 5 caracteres) e as credenciais de quem autoriza');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await discountsApi.applyToServiceOrder(serviceOrderId, {
        partsDiscount,
        laborDiscount,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(needsAuth
          ? { authorizerNumericId: Number(auth.numericId), authorizerPassword: auth.password, ...(auth.mfaCode ? { authorizerMfaCode: auth.mfaCode } : {}) }
          : {}),
      });
      setOpen(false);
      await load();
      onChanged?.();
    } catch (err) {
      const details = discountAuthorizationDetails(err);
      if (details) {
        setNeedsAuth(details);
        setFormError('');
      } else {
        setFormError(getApiErrorMessage(err, 'Não foi possível aplicar o desconto'));
      }
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-danger">{loadError}</CardContent>
      </Card>
    );
  }
  if (!state) return null;

  const partsValue = parseMoney(parts);
  const laborValue = parseMoney(labor);

  return (
    <Card data-testid="os-discount-panel">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-lg">
          <BadgePercent className="h-5 w-5" aria-hidden /> Desconto
        </CardTitle>
        {state.editable ? (
          <Button size="sm" variant="outline" onClick={openDialog}>
            {state.discountAmount > 0 ? 'Alterar desconto' : 'Dar desconto'}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Desconto só antes do pagamento.</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Peças</dt>
            <dd className="font-medium">
              {formatCurrency(state.partsDiscount)} <span className="text-muted-foreground">({pct(state.partsDiscount, state.partsTotal)}%)</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Mão de obra</dt>
            <dd className="font-medium">
              {formatCurrency(state.laborDiscount)} <span className="text-muted-foreground">({pct(state.laborDiscount, state.laborTotal)}%)</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Desconto total</dt>
            <dd className="font-medium">{formatCurrency(state.discountAmount)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Total a cobrar</dt>
            <dd className="font-semibold">{formatCurrency(state.finalTotal)}</dd>
          </div>
        </dl>
        {limits && (
          <p className="text-xs text-muted-foreground">
            Sem autorização: até {limits.product}% em peças e {limits.service}% em mão de obra. Acima disso, um gerente ou administrador
            (outra pessoa) autoriza.
          </p>
        )}
        {state.events.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Histórico de descontos</p>
            <ul className="space-y-1">
              {state.events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-1">
                  <span>
                    {ITEM_TYPE_LABEL[e.itemType]}: {formatCurrency(Number(e.discountAmount))} ({Number(e.discountPercent)}%, limite livre{' '}
                    {Number(e.freeLimitPercent)}%)
                    {e.reason ? ` — ${e.reason}` : ''}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {e.requiredAuthorization && (
                      <Badge variant="warning">
                        <ShieldCheck className="mr-1 h-3 w-3" aria-hidden /> autorizado
                      </Badge>
                    )}
                    {new Date(e.createdAt).toLocaleString('pt-BR')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(v) => !saving && setOpen(v)}>
        <DialogContent onClose={() => !saving && setOpen(false)}>
          <DialogHeader>
            <DialogTitle>Desconto da OS</DialogTitle>
            <DialogDescription>
              Informe o desconto de cada tipo (substitui o desconto atual). Peças: {formatCurrency(state.partsTotal)} · Mão de obra:{' '}
              {formatCurrency(state.laborTotal)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="os-discount-parts">Desconto em peças (R$)</Label>
                <Input id="os-discount-parts" inputMode="decimal" value={parts} onChange={(e) => setParts(e.target.value)} disabled={saving} />
                <p className="text-xs text-muted-foreground">{Number.isFinite(partsValue) ? `${pct(partsValue, state.partsTotal)}%` : '—'}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="os-discount-labor">Desconto em mão de obra (R$)</Label>
                <Input id="os-discount-labor" inputMode="decimal" value={labor} onChange={(e) => setLabor(e.target.value)} disabled={saving} />
                <p className="text-xs text-muted-foreground">{Number.isFinite(laborValue) ? `${pct(laborValue, state.laborTotal)}%` : '—'}</p>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="os-discount-reason">Motivo {needsAuth ? '(obrigatório)' : '(opcional dentro do limite)'}</Label>
              <Textarea id="os-discount-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving} />
            </div>

            {needsAuth && (
              <div className="space-y-3 rounded-md border border-border bg-warning-soft p-3" role="alert">
                <p className="text-sm text-warning">
                  {ITEM_TYPE_LABEL[needsAuth.itemType]}: {needsAuth.requestedPercent}% passa o limite sem autorização
                  {needsAuth.freeLimitPercent !== null ? ` (${needsAuth.freeLimitPercent}%)` : ''}. Um gerente ou administrador (outra pessoa)
                  precisa autorizar com as próprias credenciais.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="os-discount-auth-id">ID do autorizador</Label>
                    <Input id="os-discount-auth-id" inputMode="numeric" value={auth.numericId} onChange={(e) => setAuth({ ...auth, numericId: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="os-discount-auth-pass">Senha</Label>
                    <Input id="os-discount-auth-pass" type="password" value={auth.password} onChange={(e) => setAuth({ ...auth, password: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="os-discount-auth-mfa">Código MFA</Label>
                    <Input id="os-discount-auth-mfa" inputMode="numeric" placeholder="se tiver" value={auth.mfaCode} onChange={(e) => setAuth({ ...auth, mfaCode: e.target.value })} />
                  </div>
                </div>
              </div>
            )}

            {formError && (
              <p className="text-sm text-danger" role="alert">
                {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? 'Aplicando...' : needsAuth ? 'Autorizar e aplicar' : 'Aplicar desconto'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
