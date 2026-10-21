import { api } from '@/lib/api';

// Convênios (funcionário e empresa externa), folha, contas a receber de convênio e cobrança MANUAL.
// API: /employee-agreements, /agreement-companies, /receivables (docs/CORTEX/policies/CONVENIOS.md, COBRANCA.md).
// NÃO é o "convênio de desconto" (/partners), que só dá desconto na venda. A API é a autoridade (perfis, limites, políticas).

export type EmployeeStatus = 'ACTIVE' | 'SUSPENDED' | 'ENDED';
export type LimitType = 'FIXED' | 'SALARY_PERCENT';

export interface EmployeeAgreement {
  id: string;
  name: string;
  cpf: string;
  cpfMasked: string;
  registration: string | null;
  salary: number | null;
  limitType: LimitType | null;
  limitValue: number | null;
  effectiveLimit: { limitType: LimitType; limitValue: number; limit: number; source: 'AGREEMENT' | 'POLICY' };
  status: EmployeeStatus;
  notes: string | null;
  competence: string;
  limit: number;
  used: number;
  available: number;
}

export interface Deduction {
  id: string;
  installmentNumber: number;
  competence: string;
  amount: number;
  status: 'SCHEDULED' | 'DEDUCTED' | 'CANCELLED';
  processedAt: string | null;
  processedBy: string | null;
}

export interface EmployeeCharge {
  id: string;
  saleId: string | null;
  saleNumber: number | null;
  saleStatus: string | null;
  amount: number;
  installments: number;
  firstCompetence: string;
  createdAt: string;
  cancelledAt: string | null;
  toCompensate: number;
  deductions: Deduction[];
}

export interface EmployeeDetail extends EmployeeAgreement {
  maxInstallments: number;
  scheduledBalance: number;
  charges: EmployeeCharge[];
}

export interface EmployeeList {
  competence: string;
  policy: { enabled: boolean; limitType: LimitType; limitValue: number; maxInstallments: number };
  data: EmployeeAgreement[];
}

export interface StatementLine {
  deductionId: string;
  saleNumber: number | null;
  purchaseDate: string;
  items: Array<{ productName: string; quantity: number; unitPrice: number; totalPrice: number }>;
  purchaseAmount: number;
  installmentNumber: number;
  installments: number;
  amount: number;
  status: Deduction['status'];
  chargeCancelled: boolean;
  processedAt: string | null;
}

export interface Statement {
  company: { name: string; legalName: string | null; document: string | null } | null;
  employee: { id: string; name: string; cpf: string; registration: string | null; status: EmployeeStatus };
  competence: string;
  limit: number;
  limitType: LimitType;
  limitSource: 'AGREEMENT' | 'POLICY';
  used: number;
  available: number;
  totals: { scheduled: number; deducted: number; cancelled: number };
  futureScheduled: number;
  lines: StatementLine[];
  legalNotice: string;
  generatedAt: string;
}

export interface PayrollItem {
  id: string;
  competence: string;
  installmentNumber: number;
  installments: number;
  amount: number;
  status: Deduction['status'];
  processedAt: string | null;
  chargeCancelled: boolean;
  saleNumber: number | null;
  employee: { id: string; name: string; cpfMasked: string; registration: string | null };
}

export interface Payroll {
  competence: string;
  currentCompetence: string;
  totals: { scheduled: number; deducted: number; cancelled: number };
  byEmployee: Array<{ employee: PayrollItem['employee']; scheduled: number; deducted: number }>;
  items: PayrollItem[];
}

export type CompanyStatus = 'ACTIVE' | 'BLOCKED' | 'INACTIVE';

export interface AgreementFinancials {
  openBalance: number;
  openCount: number;
  overdueAmount: number;
  overdueCount: number;
  maxDaysOverdue: number;
  monthUsed: number;
  creditLimit: number | null;
  monthlyLimit: number | null;
  creditAvailable: number | null;
  monthlyAvailable: number | null;
  available: number | null;
  delinquent: boolean;
}

export interface AgreementCompany {
  id: string;
  legalName: string;
  tradeName: string | null;
  cnpj: string;
  cnpjMasked: string;
  contactName: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  zipCode: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  commercialTerms: string | null;
  creditLimit: number | null;
  monthlyLimit: number | null;
  paymentTermDays: number;
  interestPercentMonthly: number | null;
  finePercent: number | null;
  blockAfterDaysOverdue: number | null;
  status: CompanyStatus;
  blockedAt: string | null;
  blockedBy: string | null;
  blockedReason: string | null;
  notes: string | null;
  financials?: AgreementFinancials;
}

export interface LateCharges {
  fine: number;
  interest: number;
  total: number;
  basis: string;
}

export interface CompanyReceivable {
  id: string;
  description: string;
  amount: number;
  dueDate: string;
  paidDate: string | null;
  status: string;
  createdAt: string;
  overdue: boolean;
  daysOverdue: number;
  lateCharges: LateCharges | null;
  collectionAttempts: number;
}

export interface CompanyDetail extends AgreementCompany {
  financials: AgreementFinancials;
  effectiveBlockAfterDaysOverdue: number | null;
  receivables: CompanyReceivable[];
  history: Array<{ id: string; action: string; entity: string; userId: string | null; createdAt: string; value: any }>;
}

export type CollectionChannel = 'WHATSAPP' | 'EMAIL';

export interface CollectionAttempt {
  id: string;
  attempt?: number;
  channel: CollectionChannel;
  recipient: string | null;
  amount?: number;
  dueDate?: string;
  status: 'SENT' | 'LINK_GENERATED' | 'FAILED' | 'NOT_CONFIGURED';
  provider: string | null;
  providerMessage: string | null;
  sentBy?: string;
  sentByName?: string | null;
  createdAt: string;
  link?: string;
}

export interface ReceivableDetail {
  id: string;
  description: string;
  amount: number;
  dueDate: string;
  paidDate: string | null;
  status: string;
  createdAt: string;
  notes: string | null;
  overdue: boolean;
  daysOverdue: number;
  lateCharges: LateCharges | null;
  debtor: { kind: 'AGREEMENT_COMPANY' | 'CUSTOMER'; id: string; name: string; contactName: string; whatsapp: string | null; email: string | null; status: string | null } | null;
  collection: { allowedRoles: string[]; channels: CollectionChannel[] };
  attempts: CollectionAttempt[];
}

export interface SendCollectionResult {
  receivableId: string;
  daysOverdue: number;
  message: { subject: string; text: string };
  attempts: CollectionAttempt[];
}

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const agreementsApi = {
  listEmployees: (params: { q?: string; status?: string } = {}) => api.http.get<EmployeeList>('/employee-agreements', { params }).then((r) => r.data),
  getEmployee: (id: string) => api.http.get<EmployeeDetail>(`/employee-agreements/${id}`).then((r) => r.data),
  createEmployee: (body: Record<string, unknown>) =>
    api.http.post<EmployeeDetail>('/employee-agreements', body, { headers: { 'Idempotency-Key': newKey() } }).then((r) => r.data),
  updateEmployee: (id: string, body: Record<string, unknown>) =>
    api.http.patch<{ agreement: EmployeeDetail }>(`/employee-agreements/${id}`, body).then((r) => r.data.agreement),
  statement: (id: string, competence?: string) =>
    api.http.get<Statement>(`/employee-agreements/${id}/statement`, { params: competence ? { competence } : {} }).then((r) => r.data),
  payroll: (competence?: string, status?: string) =>
    api.http.get<Payroll>('/employee-agreements/deductions', { params: { competence, status } }).then((r) => r.data),
  processDeduction: (id: string) =>
    api.http.post(`/employee-agreements/deductions/${id}/process`, {}, { headers: { 'Idempotency-Key': newKey() } }).then((r) => r.data),

  listCompanies: (params: { q?: string; status?: string } = {}) =>
    api.http.get<{ data: AgreementCompany[] }>('/agreement-companies', { params }).then((r) => r.data.data),
  getCompany: (id: string) => api.http.get<CompanyDetail>(`/agreement-companies/${id}`).then((r) => r.data),
  createCompany: (body: Record<string, unknown>) =>
    api.http.post<AgreementCompany>('/agreement-companies', body, { headers: { 'Idempotency-Key': newKey() } }).then((r) => r.data),
  updateCompany: (id: string, body: Record<string, unknown>) =>
    api.http.patch<{ agreement: AgreementCompany }>(`/agreement-companies/${id}`, body).then((r) => r.data.agreement),
  blockCompany: (id: string, reason: string) =>
    api.http.post(`/agreement-companies/${id}/block`, { reason }, { headers: { 'Idempotency-Key': newKey() } }).then((r) => r.data),
  unblockCompany: (id: string, reason: string) =>
    api.http.post(`/agreement-companies/${id}/unblock`, { reason }, { headers: { 'Idempotency-Key': newKey() } }).then((r) => r.data),

  getReceivable: (id: string) => api.http.get<ReceivableDetail>(`/receivables/${id}`).then((r) => r.data),
  /** Uma chave por AÇÃO humana: duplo clique não gera duas mensagens. */
  sendCollection: (id: string, channels: CollectionChannel[], idempotencyKey: string = newKey()) =>
    api.http
      .post<SendCollectionResult>(`/receivables/${id}/collections`, { channels }, { headers: { 'Idempotency-Key': idempotencyKey } })
      .then((r) => r.data),
};

export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, string> = { ACTIVE: 'Ativo', SUSPENDED: 'Suspenso', ENDED: 'Encerrado' };
export const COMPANY_STATUS_LABEL: Record<CompanyStatus, string> = { ACTIVE: 'Ativa', BLOCKED: 'Bloqueada', INACTIVE: 'Inativa' };
export const DEDUCTION_STATUS_LABEL: Record<Deduction['status'], string> = { SCHEDULED: 'Prevista', DEDUCTED: 'Descontada', CANCELLED: 'Cancelada' };
export const ATTEMPT_STATUS_LABEL: Record<CollectionAttempt['status'], string> = {
  SENT: 'Enviada',
  LINK_GENERATED: 'Link do WhatsApp gerado',
  FAILED: 'Falhou',
  NOT_CONFIGURED: 'Canal não configurado (não enviada)',
};
export const CHANNEL_LABEL: Record<CollectionChannel, string> = { WHATSAPP: 'WhatsApp', EMAIL: 'E-mail' };

export const brl = (v: number | null | undefined) =>
  v == null ? 'Sem limite' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatCompetence(c: string) {
  const [y, m] = c.split('-');
  return `${m}/${y}`;
}

export function shiftCompetence(c: string, months: number) {
  const [y, m] = c.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
