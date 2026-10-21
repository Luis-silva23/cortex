'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ReportProblemButton } from '@/components/support/ReportProblemButton';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CustomerPicker, type CustomerOption } from '@/components/quotes/CustomerPicker';
import { api } from '@/lib/api';
import { warrantiesApi, type Warranty, type WarrantyClaim } from '@/lib/api/warranties';
import { getApiErrorMessage } from '@/lib/errors';
import { useUserType } from '@/lib/hooks/useUserType';
import { isManagerOrAbove } from '@/lib/role-gates';
import { CLAIM_STATUS_LABEL, formatDate, formatKm, nextClaimDecisions, warrantySummary } from '@/lib/warranty';

type StatusFilter = 'ACTIVE' | 'EXPIRED' | 'ALL';
const DECISION_LABEL = { ACCEPTED: 'Aceitar', REJECTED: 'Recusar', RESOLVED: 'Marcar como resolvida' } as const;

/**
 * Pós-venda → Garantias (docs/CORTEX/policies/GARANTIA.md): garantias vigentes/expiradas por cliente e veículo, com
 * registro de ocorrência vinculada à OS original (a API recusa fora da vigência, por prazo ou km) e decisão da
 * ocorrência pela gerência.
 */
export function WarrantyPanel() {
  const { userType } = useUserType();
  const canDecide = isManagerOrAbove(userType);
  const canOpen = !!userType && userType !== 'VIEWER';

  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [motorcycles, setMotorcycles] = useState<Array<{ id: string; brand: string; model: string; licensePlate?: string }>>([]);
  const [motorcycleId, setMotorcycleId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ACTIVE');
  const [currentKm, setCurrentKm] = useState('');
  const [rows, setRows] = useState<Warranty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [claimFor, setClaimFor] = useState<Warranty | null>(null);
  const [claimDescription, setClaimDescription] = useState('');
  const [claimKm, setClaimKm] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSaving, setClaimSaving] = useState(false);

  const [decision, setDecision] = useState<{ claim: WarrantyClaim; warranty: Warranty; status: 'ACCEPTED' | 'REJECTED' | 'RESOLVED' } | null>(null);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [returnOsId, setReturnOsId] = useState('');
  const [returnOptions, setReturnOptions] = useState<Array<{ id: string; osNumber: number }>>([]);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionSaving, setDecisionSaving] = useState(false);

  useEffect(() => {
    setMotorcycleId('');
    if (!customer) {
      setMotorcycles([]);
      return;
    }
    let cancelled = false;
    api
      .getMotorcycles({ customerId: customer.id, limit: 100 })
      .then((res) => !cancelled && setMotorcycles(res.motorcycles ?? []))
      .catch(() => !cancelled && setMotorcycles([]));
    return () => {
      cancelled = true;
    };
  }, [customer]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const km = currentKm.trim() ? Number(currentKm.replace(/\./g, '').replace(',', '.')) : undefined;
      const res = await warrantiesApi.list({
        customerId: customer?.id,
        motorcycleId: motorcycleId || undefined,
        status: status === 'ALL' ? undefined : status,
        km: km !== undefined && Number.isFinite(km) ? km : undefined,
        limit: 100,
      });
      setRows(res.warranties);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar as garantias.'));
    } finally {
      setLoading(false);
    }
  }, [customer, motorcycleId, status, currentKm]);

  useEffect(() => {
    load();
    // o km é aplicado no botão "Consultar" (não a cada tecla)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, motorcycleId, status]);

  function openClaim(w: Warranty) {
    setClaimFor(w);
    setClaimDescription('');
    setClaimKm(currentKm);
    setClaimError(null);
  }

  async function submitClaim() {
    if (!claimFor) return;
    setClaimError(null);
    const km = claimKm.trim() ? Number(claimKm.replace(/\./g, '').replace(',', '.')) : null;
    if (km !== null && !Number.isFinite(km)) {
      setClaimError('Km inválido.');
      return;
    }
    setClaimSaving(true);
    try {
      await warrantiesApi.openClaim(claimFor.id, { description: claimDescription, kmAtClaim: km });
      setClaimFor(null);
      await load();
    } catch (err) {
      setClaimError(getApiErrorMessage(err, 'Não foi possível registrar a ocorrência.'));
    } finally {
      setClaimSaving(false);
    }
  }

  async function openDecision(claim: WarrantyClaim, warranty: Warranty, next: 'ACCEPTED' | 'REJECTED' | 'RESOLVED') {
    setDecision({ claim, warranty, status: next });
    setDecisionNotes('');
    setReturnOsId(claim.newServiceOrderId ?? '');
    setDecisionError(null);
    setReturnOptions([]);
    if (next !== 'REJECTED') {
      // OS de retorno: outra OS do mesmo veículo (a API confere empresa/veículo de novo).
      try {
        const res = await api.getServiceOrders({ limit: 100 });
        setReturnOptions(
          (res.orders ?? [])
            .filter((o: any) => o.motorcycle?.id === warranty.motorcycleId && o.id !== warranty.serviceOrderId)
            .map((o: any) => ({ id: o.id, osNumber: o.osNumber }))
        );
      } catch {
        setReturnOptions([]);
      }
    }
  }

  async function submitDecision() {
    if (!decision) return;
    setDecisionError(null);
    setDecisionSaving(true);
    try {
      await warrantiesApi.decideClaim(decision.claim.id, {
        status: decision.status,
        decisionNotes,
        newServiceOrderId: decision.status !== 'REJECTED' && returnOsId ? returnOsId : undefined,
      });
      setDecision(null);
      await load();
    } catch (err) {
      setDecisionError(getApiErrorMessage(err, 'Não foi possível registrar a decisão.'));
    } finally {
      setDecisionSaving(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="warranty-panel">
      <Card>
        <CardContent className="grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
          <div className="space-y-1 md:col-span-2">
            <p className="text-sm font-medium leading-none text-foreground">Cliente</p>
            <CustomerPicker value={customer} onChange={setCustomer} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="warranty-moto">Veículo</Label>
            <Select id="warranty-moto" value={motorcycleId} onChange={(e) => setMotorcycleId(e.target.value)} disabled={!customer}>
              <option value="">{customer ? 'Todos os veículos' : 'Escolha o cliente'}</option>
              {motorcycles.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.brand} {m.model} {m.licensePlate ? `— ${m.licensePlate}` : ''}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="warranty-status">Situação</Label>
            <Select id="warranty-status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="ACTIVE">Vigentes</option>
              <option value="EXPIRED">Expiradas</option>
              <option value="ALL">Todas</option>
            </Select>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="warranty-current-km">Km atual do veículo (opcional — confere o limite de km)</Label>
            <div className="flex gap-2">
              <Input id="warranty-current-km" inputMode="numeric" value={currentKm} onChange={(e) => setCurrentKm(e.target.value)} placeholder="Ex.: 43.100" />
              <Button type="button" variant="outline" onClick={load}>
                Consultar
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="p-12 text-center text-muted-foreground">Carregando...</div>
      ) : error ? (
        <div className="p-12 text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" aria-hidden />
          <p className="mb-4 text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={load}>
            Tentar novamente
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-12 text-center">
          <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden />
          <h3 className="mb-2 text-lg font-medium text-foreground">Nenhuma garantia encontrada</h3>
          <p className="text-muted-foreground">As garantias nascem no encerramento da OS (decisão &quot;com garantia&quot;).</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((w) => (
            <li key={w.id}>
              <Card data-testid="warranty-row">
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <p className={`text-sm font-semibold ${w.status === 'EXPIRED' ? 'text-muted-foreground' : 'text-success'}`}>{warrantySummary(w)}</p>
                      <p className="text-sm text-muted-foreground">
                        {w.serviceOrder?.customer?.name}
                        {w.serviceOrder?.motorcycle ? ` — ${w.serviceOrder.motorcycle.brand} ${w.serviceOrder.motorcycle.model}${w.serviceOrder.motorcycle.licensePlate ? ` (${w.serviceOrder.motorcycle.licensePlate})` : ''}` : ''}
                        {' · '}
                        {w.durationLabel}
                        {w.kmLimit ? ` ou ${formatKm(w.kmLimit)} km (o que ocorrer primeiro)` : ''} · início {formatDate(w.startDate)}
                        {w.evaluatedKm != null ? ` · km considerado ${formatKm(Number(w.evaluatedKm))}` : ''}
                      </p>
                      {w.conditions && <p className="text-xs text-muted-foreground">Condições: {w.conditions}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={w.status === 'EXPIRED' ? 'secondary' : 'success'}>{w.status === 'EXPIRED' ? 'Expirada' : 'Vigente'}</Badge>
                      <Link href={`/dashboard/service-orders/${w.serviceOrderId}`} className="text-sm text-primary underline-offset-4 hover:underline">
                        Ver OS
                      </Link>
                      <ReportProblemButton context={{ module: 'POS_VENDA', screen: 'Pós-venda → Garantias', entityType: 'WARRANTY', entityId: w.id }} label="Relatar" />
                      {canOpen && w.status === 'ACTIVE' && (
                        <Button size="sm" onClick={() => openClaim(w)}>
                          Registrar ocorrência
                        </Button>
                      )}
                    </div>
                  </div>
                  {w.claims?.length > 0 && (
                    <ul className="space-y-2 border-t border-border pt-2">
                      {w.claims.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <Badge variant="outline">{CLAIM_STATUS_LABEL[c.status] ?? c.status}</Badge>
                          <span className="text-foreground">{c.description}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatDate(c.createdAt)}
                            {c.kmAtClaim != null ? ` · ${formatKm(Number(c.kmAtClaim))} km` : ''}
                            {c.decisionNotes ? ` · ${c.decisionNotes}` : ''}
                          </span>
                          {canDecide &&
                            nextClaimDecisions(c.status).map((next) => (
                              <Button key={next} size="sm" variant="outline" onClick={() => openDecision(c, w, next)}>
                                {DECISION_LABEL[next]}
                              </Button>
                            ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!claimFor} onOpenChange={(o) => !o && setClaimFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ocorrência de garantia — OS #{claimFor?.serviceOrder?.osNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-6 py-4">
            {claimFor && <p className="text-xs text-muted-foreground">{warrantySummary(claimFor)}</p>}
            <div className="space-y-1">
              <Label htmlFor="claim-description">O que o cliente relatou</Label>
              <Textarea id="claim-description" rows={3} value={claimDescription} onChange={(e) => setClaimDescription(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="claim-km">Km atual{claimFor?.kmUntil != null ? ' (obrigatório: garantia com limite de km)' : ''}</Label>
              <Input id="claim-km" inputMode="numeric" value={claimKm} onChange={(e) => setClaimKm(e.target.value)} />
            </div>
            {claimError && (
              <p className="text-sm text-danger" role="alert">
                {claimError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClaimFor(null)}>
              Cancelar
            </Button>
            <Button onClick={submitClaim} disabled={claimSaving}>
              {claimSaving ? 'Registrando...' : 'Registrar ocorrência'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!decision} onOpenChange={(o) => !o && setDecision(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{decision ? DECISION_LABEL[decision.status] : ''} ocorrência</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-6 py-4">
            {decision && <p className="text-sm text-muted-foreground">{decision.claim.description}</p>}
            <div className="space-y-1">
              <Label htmlFor="decision-notes">Notas da decisão</Label>
              <Textarea id="decision-notes" rows={3} value={decisionNotes} onChange={(e) => setDecisionNotes(e.target.value)} />
            </div>
            {decision?.status !== 'REJECTED' && (
              <div className="space-y-1">
                <Label htmlFor="decision-return-os">OS de retorno (opcional, mesmo veículo)</Label>
                <Select id="decision-return-os" value={returnOsId} onChange={(e) => setReturnOsId(e.target.value)}>
                  <option value="">Sem OS de retorno</option>
                  {returnOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      OS #{o.osNumber}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {decisionError && (
              <p className="text-sm text-danger" role="alert">
                {decisionError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecision(null)}>
              Cancelar
            </Button>
            <Button onClick={submitDecision} disabled={decisionSaving}>
              {decisionSaving ? 'Salvando...' : 'Confirmar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
