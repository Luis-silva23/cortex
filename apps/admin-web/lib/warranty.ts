// Garantia de OS no Admin Web (docs/CORTEX/policies/GARANTIA.md). A API é a autoridade (política, vigência, itens,
// permissões); aqui só montamos o corpo do encerramento e os textos da tela.

export type WarrantyCoverage = 'SERVICE' | 'PART' | 'SERVICE_AND_PART';
export type WarrantyDurationUnit = 'DAYS' | 'MONTHS' | 'YEARS';
export type WarrantyClaimStatus = 'OPEN' | 'ACCEPTED' | 'REJECTED' | 'RESOLVED';

export const COVERAGE_LABEL: Record<WarrantyCoverage, string> = {
  SERVICE: 'Serviço',
  PART: 'Peça',
  SERVICE_AND_PART: 'Serviço + peça',
};

export const UNIT_LABEL: Record<WarrantyDurationUnit, [string, string]> = {
  DAYS: ['dia', 'dias'],
  MONTHS: ['mês', 'meses'],
  YEARS: ['ano', 'anos'],
};

export const CLAIM_STATUS_LABEL: Record<WarrantyClaimStatus, string> = {
  OPEN: 'Aberta',
  ACCEPTED: 'Aceita',
  REJECTED: 'Recusada',
  RESOLVED: 'Resolvida',
};

/** Prazos rápidos do diálogo de encerramento; "personalizado" abre quantidade + unidade. */
export const DURATION_PRESETS: Array<{ key: string; value: number; unit: WarrantyDurationUnit }> = [
  { key: '2M', value: 2, unit: 'MONTHS' },
  { key: '3M', value: 3, unit: 'MONTHS' },
  { key: '6M', value: 6, unit: 'MONTHS' },
  { key: '1Y', value: 1, unit: 'YEARS' },
];

export const durationLabel = (value: number, unit: WarrantyDurationUnit) => `${value} ${UNIT_LABEL[unit]?.[value === 1 ? 0 : 1] ?? unit}`;

export interface ServiceOrderItemLike {
  id: string;
  itemType: 'SERVICE' | 'PART';
  description: string;
}

export interface CloseWarrantyForm {
  decision: '' | 'NONE' | 'GRANTED';
  coverage: WarrantyCoverage;
  durationValue: string;
  durationUnit: WarrantyDurationUnit;
  useKmLimit: boolean;
  kmLimit: string;
  startKm: string;
  coveredItemIds: string[];
  conditions: string;
  notes: string;
}

export type WarrantyDecisionPayload =
  | { decision: 'NONE' }
  | {
      decision: 'GRANTED';
      coverage: WarrantyCoverage;
      durationValue: number;
      durationUnit: WarrantyDurationUnit;
      kmLimit: number | null;
      startKm?: number;
      coveredItemIds: string[];
      conditions?: string;
      notes?: string;
    };

export const itemsForCoverage = (items: ServiceOrderItemLike[], coverage: WarrantyCoverage) =>
  items.filter((i) => coverage === 'SERVICE_AND_PART' || i.itemType === coverage);

const toNumber = (s: string) => {
  const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return String(s).trim() === '' || !Number.isFinite(n) ? null : n;
};

/**
 * Valida o formulário e monta `warranty` do POST /service-orders/:id/status. `required` = a política exige decisão.
 * Retorna `payload: undefined` quando nada foi escolhido e a decisão é opcional.
 */
export function buildWarrantyDecision(
  form: CloseWarrantyForm,
  items: ServiceOrderItemLike[],
  opts: { required: boolean; enabled: boolean; entryKm: number }
): { ok: true; payload: WarrantyDecisionPayload | undefined } | { ok: false; error: string } {
  if (!opts.enabled) return { ok: true, payload: form.decision === 'NONE' ? { decision: 'NONE' } : undefined };
  if (form.decision === '') {
    return opts.required ? { ok: false, error: 'Escolha "Sem garantia" ou "Com garantia" para encerrar.' } : { ok: true, payload: undefined };
  }
  if (form.decision === 'NONE') return { ok: true, payload: { decision: 'NONE' } };

  const durationValue = toNumber(form.durationValue);
  if (durationValue === null || !Number.isInteger(durationValue) || durationValue < 1) {
    return { ok: false, error: 'Informe o prazo da garantia (número inteiro a partir de 1).' };
  }
  let kmLimit: number | null = null;
  if (form.useKmLimit) {
    kmLimit = toNumber(form.kmLimit);
    if (kmLimit === null || !Number.isInteger(kmLimit) || kmLimit < 1) return { ok: false, error: 'Informe o limite de km (número inteiro a partir de 1).' };
  }
  let startKm: number | undefined;
  if (form.startKm.trim() !== '') {
    const n = toNumber(form.startKm);
    if (n === null || n < 0) return { ok: false, error: 'Km inicial inválido.' };
    if (n < opts.entryKm) return { ok: false, error: `O km inicial não pode ser menor que o km de entrada da OS (${formatKm(opts.entryKm)}).` };
    startKm = n;
  }
  const allowed = new Set(itemsForCoverage(items, form.coverage).map((i) => i.id));
  const coveredItemIds = form.coveredItemIds.filter((id) => allowed.has(id));
  if (coveredItemIds.length === 0) {
    return { ok: false, error: 'Marque ao menos um item da OS coberto pela garantia.' };
  }
  return {
    ok: true,
    payload: {
      decision: 'GRANTED',
      coverage: form.coverage,
      durationValue,
      durationUnit: form.durationUnit,
      kmLimit,
      ...(startKm !== undefined ? { startKm } : {}),
      coveredItemIds,
      ...(form.conditions.trim() ? { conditions: form.conditions.trim() } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    },
  };
}

export const formatKm = (km: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(km);
export const formatDate = (d: string | Date, timeZone?: string) => new Intl.DateTimeFormat('pt-BR', { timeZone }).format(new Date(d));

export interface WarrantyLike {
  status?: 'ACTIVE' | 'EXPIRED';
  expiredBy?: 'DATE' | 'KM' | null;
  coverage: WarrantyCoverage;
  validUntil: string | Date;
  kmUntil?: string | number | null;
  coveredItems?: Array<{ description: string }> | null;
  serviceOrder?: { osNumber?: number } | null;
}

/** "GARANTIA VIGENTE · OS #1842 · Serviço: troca de kit relação · Validade: 27/12/2026 · KM: até 45.350" */
export function warrantySummary(w: WarrantyLike, timeZone?: string): string {
  const head =
    w.status === 'EXPIRED'
      ? `GARANTIA EXPIRADA${w.expiredBy === 'KM' ? ' (km)' : w.expiredBy === 'DATE' ? ' (prazo)' : ''}`
      : 'GARANTIA VIGENTE';
  const parts = [head];
  if (w.serviceOrder?.osNumber !== undefined) parts.push(`OS #${w.serviceOrder.osNumber}`);
  const items = (w.coveredItems ?? []).map((i) => i.description).join(', ');
  parts.push(`${COVERAGE_LABEL[w.coverage] ?? w.coverage}${items ? `: ${items}` : ''}`);
  parts.push(`Validade: ${formatDate(w.validUntil, timeZone)}`);
  if (w.kmUntil !== null && w.kmUntil !== undefined) parts.push(`KM: até ${formatKm(Number(w.kmUntil))}`);
  return parts.join(' · ');
}

/** Próximas decisões possíveis de uma ocorrência (espelha a API: OPEN → aceitar/recusar; ACCEPTED → resolver). */
export function nextClaimDecisions(status: WarrantyClaimStatus): Array<'ACCEPTED' | 'REJECTED' | 'RESOLVED'> {
  if (status === 'OPEN') return ['ACCEPTED', 'REJECTED'];
  if (status === 'ACCEPTED') return ['RESOLVED'];
  return [];
}
