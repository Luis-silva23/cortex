// Regras puras da tela Fiscal do Admin Web (sem React/axios, testáveis).

export interface FiscalConfigForm {
  nfceEnabled: boolean;
  nfceSeriesNumber: string;
  nfeEnabled: boolean;
  nfeSeriesNumber: string;
  certificatePath: string;
  // Campos de segredo: SEMPRE começam vazios. O valor gravado nunca volta da
  // API (só `hasCertificatePassword`/`hasCscToken`) e a tela nunca o pré-preenche.
  certificatePassword: string;
  cscId: string;
  cscToken: string;
  environment: string;
  cancelTimeLimit: string;
}

// Valores iniciais para uma filial sem configuração. Trocar de filial precisa
// voltar a estes valores — senão o formulário mantém os dados da filial anterior
// e "Salvar" gravaria a configuração de uma filial na outra.
export function defaultFiscalForm(): FiscalConfigForm {
  return {
    nfceEnabled: false,
    nfceSeriesNumber: '1',
    nfeEnabled: false,
    nfeSeriesNumber: '1',
    certificatePath: '',
    certificatePassword: '',
    cscId: '',
    cscToken: '',
    environment: 'HOMOLOGACAO',
    cancelTimeLimit: '24',
  };
}

export function fiscalConfigToForm(config: any): FiscalConfigForm {
  const defaults = defaultFiscalForm();
  if (!config) return defaults;
  return {
    nfceEnabled: Boolean(config.nfceEnabled),
    nfceSeriesNumber: String(config.nfceSeriesNumber ?? defaults.nfceSeriesNumber),
    nfeEnabled: Boolean(config.nfeEnabled),
    nfeSeriesNumber: String(config.nfeSeriesNumber ?? defaults.nfeSeriesNumber),
    certificatePath: config.certificatePath ?? '',
    certificatePassword: '',
    cscId: config.cscId ?? '',
    cscToken: '',
    environment: config.environment ?? defaults.environment,
    cancelTimeLimit: String(config.cancelTimeLimit ?? defaults.cancelTimeLimit),
  };
}

export type FiscalSecretField = 'certificatePassword' | 'cscToken';

// A API passou a devolver `hasCertificatePassword`/`hasCscToken` (booleanos) em
// vez do segredo em texto puro. Se os booleanos vierem, eles mandam; se vierem
// de uma API ainda na versão antiga, cai na checagem antiga (o campo existir
// e não estar vazio) — só para indicar "configurado", nunca para exibir o valor.
export function hasStoredSecret(config: any, field: FiscalSecretField): boolean {
  if (!config) return false;
  const flag = field === 'certificatePassword' ? config.hasCertificatePassword : config.hasCscToken;
  if (typeof flag === 'boolean') return flag;
  const legacy = config[field];
  return typeof legacy === 'string' && legacy.length > 0;
}

export interface FiscalConfigPayload {
  branchId: string;
  nfceEnabled: boolean;
  nfceSeriesNumber: number;
  nfeEnabled: boolean;
  nfeSeriesNumber: number;
  certificatePath?: string;
  certificatePassword?: string;
  cscId?: string;
  cscToken?: string;
  environment: string;
  cancelTimeLimit: number;
}

// Segredo só entra no payload quando o usuário digitou um valor novo: campo
// vazio significa "manter o que já está gravado" (a API também ignora vazio,
// mas não dependemos disso). Não faz trim — uma senha pode ter espaço nas pontas.
export function buildFiscalConfigPayload(branchId: string, form: FiscalConfigForm): FiscalConfigPayload {
  return {
    branchId,
    nfceEnabled: form.nfceEnabled,
    nfceSeriesNumber: Number(form.nfceSeriesNumber),
    nfeEnabled: form.nfeEnabled,
    nfeSeriesNumber: Number(form.nfeSeriesNumber),
    certificatePath: form.certificatePath || undefined,
    certificatePassword: form.certificatePassword ? form.certificatePassword : undefined,
    cscId: form.cscId || undefined,
    cscToken: form.cscToken ? form.cscToken : undefined,
    environment: form.environment,
    cancelTimeLimit: Number(form.cancelTimeLimit),
  };
}

// A API exige motivo no cancelamento ("Cancellation reason is required" → 400).
// Devolve o motivo limpo, ou null se estiver vazio/só espaços.
export function normalizeCancellationReason(raw: string | null | undefined): string | null {
  const reason = (raw ?? '').trim();
  return reason === '' ? null : reason;
}

export interface FiscalSaleOption {
  id: string;
  branchId?: string | null;
  status?: string | null;
}

// Venda que a tela oferece para emissão (docs/CORTEX/policies/FISCAL.md): só a CONCLUÍDA (paga). Cancelada não
// ocorreu; pendente/parcialmente paga não foi concluída — a API recusa com 409 (FISCAL_SALE_CANCELLED /
// FISCAL_SALE_NOT_COMPLETED). Devolvida também não é oferecida: devolução fiscal é operação própria (decisão pendente).
export function isSaleOfferedForEmission(sale: FiscalSaleOption): boolean {
  return sale.status === 'PAID';
}

// A API só emite se `sale.branchId === branchId` (senão "Sale not found"), então
// a filial NÃO é uma escolha independente: vem sempre da venda escolhida.
export function branchIdForSale(sales: FiscalSaleOption[], saleId: string): string | null {
  const sale = sales.find((s) => s.id === saleId);
  return sale?.branchId ? sale.branchId : null;
}
