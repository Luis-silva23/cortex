'use client';

import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { policiesApi } from '@/lib/api/policies';
import { warrantiesApi } from '@/lib/api/warranties';
import { getApiErrorMessage } from '@/lib/errors';
import {
  buildWarrantyDecision,
  CloseWarrantyForm,
  COVERAGE_LABEL,
  DURATION_PRESETS,
  durationLabel,
  formatKm,
  itemsForCoverage,
  WarrantyCoverage,
  WarrantyDurationUnit,
} from '@/lib/warranty';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  os: any;
  onClosed: () => void;
}

interface WarrantyPolicy {
  enabled: boolean;
  required: boolean;
  defaultValue: number | null;
  defaultUnit: WarrantyDurationUnit;
  defaultKm: number | null;
}

/**
 * Encerramento da OS com a decisão de garantia (docs/CORTEX/policies/GARANTIA.md): sem garantia / com garantia
 * (tipo, prazo, km "o que ocorrer primeiro", itens cobertos, condições). Sugestões vêm das políticas efetivas da filial
 * da OS; a API valida tudo e grava a garantia na mesma transação do encerramento.
 */
export function CloseServiceOrderDialog({ open, onOpenChange, os, onClosed }: Props) {
  const items = useMemo(() => (os?.items ?? []) as Array<{ id: string; itemType: 'SERVICE' | 'PART'; description: string }>, [os]);
  const entryKm = Number(os?.entryKilometer ?? 0);
  const [policy, setPolicy] = useState<WarrantyPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [preset, setPreset] = useState<string>('CUSTOM');
  const [form, setForm] = useState<CloseWarrantyForm>(() => initialForm(items, null, os));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setPolicyError(null);
    policiesApi
      .effective(os?.branchId)
      .then(({ values }) => {
        if (cancelled) return;
        const p: WarrantyPolicy = {
          enabled: values['warranty.enabled'] !== false,
          required: values['warranty.requireDecisionOnClose'] !== false,
          defaultValue: (values['warranty.defaultDurationValue'] as number | null) ?? null,
          defaultUnit: ((values['warranty.defaultDurationUnit'] as WarrantyDurationUnit) ?? 'MONTHS'),
          defaultKm: (values['warranty.defaultKmLimit'] as number | null) ?? null,
        };
        setPolicy(p);
        const f = initialForm(items, p, os);
        setForm(f);
        setPreset(DURATION_PRESETS.find((d) => String(d.value) === f.durationValue && d.unit === f.durationUnit)?.key ?? 'CUSTOM');
      })
      .catch((err) => {
        if (cancelled) return;
        // Sem as políticas, a tela assume o padrão do produto (garantia habilitada e decisão obrigatória); a API decide.
        setPolicy({ enabled: true, required: true, defaultValue: null, defaultUnit: 'MONTHS', defaultKm: null });
        setPolicyError(getApiErrorMessage(err, 'Não foi possível carregar as sugestões de garantia.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, os, items]);

  const set = <K extends keyof CloseWarrantyForm>(k: K, v: CloseWarrantyForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  function changeCoverage(coverage: WarrantyCoverage) {
    setForm((f) => ({ ...f, coverage, coveredItemIds: itemsForCoverage(items, coverage).map((i) => i.id) }));
  }

  function choosePreset(key: string) {
    setPreset(key);
    const p = DURATION_PRESETS.find((d) => d.key === key);
    if (p) setForm((f) => ({ ...f, durationValue: String(p.value), durationUnit: p.unit }));
  }

  function toggleItem(id: string, checked: boolean) {
    setForm((f) => ({ ...f, coveredItemIds: checked ? [...new Set([...f.coveredItemIds, id])] : f.coveredItemIds.filter((x) => x !== id) }));
  }

  async function submit() {
    if (!policy) return;
    setError(null);
    const built = buildWarrantyDecision(form, items, { required: policy.required, enabled: policy.enabled, entryKm });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    try {
      await warrantiesApi.closeServiceOrder(os.id, { warranty: built.payload });
      onOpenChange(false);
      onClosed();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível encerrar a OS.'));
    } finally {
      setSaving(false);
    }
  }

  const coverable = itemsForCoverage(items, form.coverage);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Encerrar OS #{os?.osNumber} — garantia</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 py-4" data-testid="close-os-dialog">
          {!policy ? (
            <p className="text-sm text-muted-foreground">Carregando política de garantia...</p>
          ) : !policy.enabled ? (
            <div className="rounded-md border border-border bg-muted p-3 text-sm text-foreground">
              A garantia de OS está desabilitada na política desta empresa/filial. A OS será encerrada sem garantia.
            </div>
          ) : (
            <>
              {policyError && <p className="text-xs text-muted-foreground">{policyError}</p>}
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">
                  Decisão de garantia{policy.required ? ' (obrigatória)' : ''}
                </legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className={`flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm ${form.decision === 'NONE' ? 'border-primary bg-muted' : 'border-border'}`}>
                    <input type="radio" name="warranty-decision" value="NONE" checked={form.decision === 'NONE'} onChange={() => set('decision', 'NONE')} />
                    <ShieldOff className="h-4 w-4" aria-hidden /> Sem garantia
                  </label>
                  <label className={`flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm ${form.decision === 'GRANTED' ? 'border-primary bg-muted' : 'border-border'}`}>
                    <input type="radio" name="warranty-decision" value="GRANTED" checked={form.decision === 'GRANTED'} onChange={() => set('decision', 'GRANTED')} />
                    <ShieldCheck className="h-4 w-4" aria-hidden /> Com garantia
                  </label>
                </div>
              </fieldset>

              {form.decision === 'GRANTED' && (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <Label htmlFor="warranty-coverage">Tipo</Label>
                    <Select id="warranty-coverage" value={form.coverage} onChange={(e) => changeCoverage(e.target.value as WarrantyCoverage)}>
                      {(Object.keys(COVERAGE_LABEL) as WarrantyCoverage[]).map((c) => (
                        <option key={c} value={c}>
                          {COVERAGE_LABEL[c]}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm font-medium text-foreground">Prazo</p>
                    <div className="flex flex-wrap gap-2">
                      {DURATION_PRESETS.map((p) => (
                        <Button key={p.key} type="button" size="sm" variant={preset === p.key ? 'default' : 'outline'} onClick={() => choosePreset(p.key)}>
                          {durationLabel(p.value, p.unit)}
                        </Button>
                      ))}
                      <Button type="button" size="sm" variant={preset === 'CUSTOM' ? 'default' : 'outline'} onClick={() => setPreset('CUSTOM')}>
                        Personalizado
                      </Button>
                    </div>
                    {preset === 'CUSTOM' && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="warranty-duration">Quantidade</Label>
                          <Input id="warranty-duration" type="number" min={1} value={form.durationValue} onChange={(e) => set('durationValue', e.target.value)} />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="warranty-unit">Unidade</Label>
                          <Select id="warranty-unit" value={form.durationUnit} onChange={(e) => set('durationUnit', e.target.value as WarrantyDurationUnit)}>
                            <option value="DAYS">Dias</option>
                            <option value="MONTHS">Meses</option>
                            <option value="YEARS">Anos</option>
                          </Select>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 rounded-md border border-border p-3">
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <Checkbox checked={form.useKmLimit} onChange={(e) => set('useKmLimit', e.target.checked)} aria-label="Limitar por quilometragem" />
                      Limitar também por quilometragem — vale o que ocorrer primeiro (prazo OU km)
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="warranty-start-km">Km inicial (saída da OS)</Label>
                        <Input
                          id="warranty-start-km"
                          inputMode="numeric"
                          value={form.startKm}
                          onChange={(e) => set('startKm', e.target.value)}
                          placeholder={formatKm(entryKm)}
                        />
                        <p className="text-xs text-muted-foreground">Entrada da OS: {formatKm(entryKm)} km</p>
                      </div>
                      {form.useKmLimit && (
                        <div className="space-y-1">
                          <Label htmlFor="warranty-km-limit">Limite de km</Label>
                          <Input id="warranty-km-limit" inputMode="numeric" value={form.kmLimit} onChange={(e) => set('kmLimit', e.target.value)} placeholder="Ex.: 3000" />
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm font-medium text-foreground">Itens cobertos</p>
                    {coverable.length === 0 ? (
                      <p className="text-sm text-danger">A OS não tem {form.coverage === 'PART' ? 'peça' : form.coverage === 'SERVICE' ? 'serviço' : 'itens'} para este tipo de garantia.</p>
                    ) : (
                      <ul className="space-y-1">
                        {coverable.map((item) => (
                          <li key={item.id}>
                            <label className="flex items-center gap-2 text-sm text-foreground">
                              <Checkbox checked={form.coveredItemIds.includes(item.id)} onChange={(e) => toggleItem(item.id, e.target.checked)} />
                              <span className="text-muted-foreground">{item.itemType === 'PART' ? 'Peça' : 'Serviço'}:</span> {item.description}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="warranty-conditions">Condições</Label>
                    <Textarea id="warranty-conditions" rows={2} value={form.conditions} onChange={(e) => set('conditions', e.target.value)} placeholder="Ex.: uso normal; não cobre queda ou competição" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="warranty-notes">Observações</Label>
                    <Textarea id="warranty-notes" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A garantia começa na entrega do veículo{os?.deliveryDate ? ` (${new Date(os.deliveryDate).toLocaleDateString('pt-BR')})` : ''}.
                  </p>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={saving || !policy}>
            {saving ? 'Encerrando...' : 'Encerrar OS'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function initialForm(items: Array<{ id: string; itemType: 'SERVICE' | 'PART' }>, p: WarrantyPolicy | null, os: any): CloseWarrantyForm {
  const coverage: WarrantyCoverage = items.some((i) => i.itemType === 'PART') && items.some((i) => i.itemType === 'SERVICE') ? 'SERVICE_AND_PART' : items.some((i) => i.itemType === 'PART') ? 'PART' : 'SERVICE';
  return {
    decision: '',
    coverage,
    durationValue: p?.defaultValue ? String(p.defaultValue) : '3',
    durationUnit: p?.defaultUnit ?? 'MONTHS',
    useKmLimit: !!p?.defaultKm,
    kmLimit: p?.defaultKm ? String(p.defaultKm) : '',
    startKm: os?.exitKilometer != null ? String(Number(os.exitKilometer)) : '',
    coveredItemIds: itemsForCoverage(items as any, coverage).map((i) => i.id),
    conditions: '',
    notes: '',
  };
}
