// Apresentação das políticas (Configurações → Políticas). A regra e a validação são da API; aqui só rótulos em
// português, o tipo de campo de cada chave e a conversão do que o usuário digitou.

export const GROUP_LABELS: Record<string, string> = {
  EMPRESA: 'Empresa',
  DESCONTO: 'Descontos',
  CAIXA: 'Caixa',
  ORCAMENTO: 'Orçamentos',
  AGENDA: 'Agenda',
  GARANTIA: 'Garantia',
  CONVENIO_FUNCIONARIO: 'Convênio de funcionário',
  CONVENIO_EMPRESA: 'Convênio com empresa',
  COBRANCA: 'Cobrança',
  FISCAL: 'Fiscal',
  DEVOLUCAO_FORNECEDOR: 'Devolução ao fornecedor',
  COMISSAO: 'Comissão',
};

export const SOURCE_LABELS: Record<string, string> = {
  DEFAULT: 'Padrão do sistema',
  COMPANY: 'Definido pela empresa',
  BRANCH: 'Específico desta filial',
};

export type FieldKind =
  | { kind: 'boolean' }
  | { kind: 'number'; suffix?: string; nullable?: boolean; nullLabel?: string; integer?: boolean }
  | { kind: 'text' }
  | { kind: 'enum'; options: Array<{ value: string; label: string }> }
  | { kind: 'multi'; options: Array<{ value: string; label: string }> };

const ROLE_OPTIONS = [
  { value: 'MANAGER', label: 'Gerente' },
  { value: 'COMPANY_ADMIN', label: 'Administrador' },
];

const FIELDS: Record<string, FieldKind> = {
  'company.timezone': { kind: 'text' },
  'discount.productFreePercent': { kind: 'number', suffix: '%' },
  'discount.serviceFreePercent': { kind: 'number', suffix: '%' },
  'discount.authorizerRoles': { kind: 'multi', options: ROLE_OPTIONS },
  'cash.forceCloseRoles': { kind: 'multi', options: ROLE_OPTIONS },
  'cash.blockCloseWithPendingPayments': { kind: 'boolean' },
  'cash.blockCloseWithOpenSales': { kind: 'boolean' },
  'quote.expirationDays': { kind: 'number', suffix: 'dias', integer: true },
  'quote.autoExpire': { kind: 'boolean' },
  'quote.allowReopen': { kind: 'boolean' },
  'agenda.requireCustomerConfirmation': { kind: 'boolean' },
  'agenda.completionAuthorizerRoles': { kind: 'multi', options: ROLE_OPTIONS },
  'agenda.slotMinutes': { kind: 'number', suffix: 'min', integer: true },
  'agenda.maxPerSlot': { kind: 'number', nullable: true, nullLabel: 'Sem limite', integer: true },
  'agenda.respectBusinessHours': { kind: 'boolean' },
  'warranty.enabled': { kind: 'boolean' },
  'warranty.requireDecisionOnClose': { kind: 'boolean' },
  'warranty.defaultDurationValue': { kind: 'number', nullable: true, nullLabel: 'Sem sugestão', integer: true },
  'warranty.defaultDurationUnit': {
    kind: 'enum',
    options: [
      { value: 'DAYS', label: 'Dias' },
      { value: 'MONTHS', label: 'Meses' },
      { value: 'YEARS', label: 'Anos' },
    ],
  },
  'warranty.defaultKmLimit': { kind: 'number', suffix: 'km', nullable: true, nullLabel: 'Sem sugestão', integer: true },
  'employeeAgreement.enabled': { kind: 'boolean' },
  'employeeAgreement.limitType': {
    kind: 'enum',
    options: [
      { value: 'FIXED', label: 'Valor fixo por mês' },
      { value: 'SALARY_PERCENT', label: 'Percentual do salário por mês' },
    ],
  },
  'employeeAgreement.limitValue': { kind: 'number' },
  'employeeAgreement.maxInstallments': { kind: 'number', suffix: 'parcelas', integer: true },
  'companyAgreement.enabled': { kind: 'boolean' },
  'companyAgreement.defaultPaymentTermDays': { kind: 'number', suffix: 'dias', integer: true },
  'companyAgreement.defaultBlockAfterDaysOverdue': { kind: 'number', suffix: 'dias', nullable: true, nullLabel: 'Sem bloqueio automático', integer: true },
  'collection.allowedRoles': { kind: 'multi', options: ROLE_OPTIONS },
  'collection.channels': {
    kind: 'multi',
    options: [
      { value: 'WHATSAPP', label: 'WhatsApp' },
      { value: 'EMAIL', label: 'E-mail' },
    ],
  },
  'fiscal.enabledOperations': {
    kind: 'multi',
    options: [
      { value: 'SALE', label: 'Venda' },
      { value: 'RETURN', label: 'Devolução' },
      { value: 'TRANSFER', label: 'Transferência' },
    ],
  },
};

/** Tipo de campo da chave; chave nova sem entrada acima é deduzida do valor padrão. */
export function fieldFor(key: string, defaultValue: unknown): FieldKind {
  if (FIELDS[key]) return FIELDS[key];
  if (typeof defaultValue === 'boolean') return { kind: 'boolean' };
  if (typeof defaultValue === 'number' || defaultValue === null) return { kind: 'number', nullable: defaultValue === null };
  return { kind: 'text' };
}

const numberBR = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

export function formatPolicyValue(key: string, value: unknown, defaultValue?: unknown): string {
  const field = fieldFor(key, defaultValue);
  if (field.kind === 'boolean') return value ? 'Sim' : 'Não';
  if (field.kind === 'number') {
    if (value === null || value === undefined) return field.nullLabel ?? '—';
    return `${numberBR(Number(value))}${field.suffix ? (field.suffix === '%' ? '%' : ` ${field.suffix}`) : ''}`;
  }
  if (field.kind === 'enum') return field.options.find((o) => o.value === value)?.label ?? String(value ?? '—');
  if (field.kind === 'multi') {
    const list = Array.isArray(value) ? value : [];
    return list.length ? list.map((v) => field.options.find((o) => o.value === v)?.label ?? String(v)).join(', ') : 'Nenhum';
  }
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

/**
 * Converte o que veio do formulário no valor enviado à API. Número aceita vírgula decimal; vazio num campo que admite
 * "sem limite" vira null. Devolve `{ error }` quando o texto não é um número.
 */
export function parsePolicyInput(field: FieldKind, raw: unknown): { value: unknown } | { error: string } {
  if (field.kind === 'boolean') return { value: Boolean(raw) };
  if (field.kind === 'multi') return { value: Array.isArray(raw) ? raw : [] };
  if (field.kind === 'enum' || field.kind === 'text') return { value: typeof raw === 'string' ? raw.trim() : raw };
  const text = String(raw ?? '').trim();
  if (text === '') return field.nullable ? { value: null } : { error: 'Informe um número' };
  // "1.234,5" (brasileiro) ou "5.5": ponto só é milhar quando há vírgula (mesma regra de lib/excel-parser.ts).
  const n = Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
  if (!Number.isFinite(n)) return { error: 'Informe um número' };
  if (field.integer && !Number.isInteger(n)) return { error: 'Use um número inteiro' };
  return { value: n };
}
