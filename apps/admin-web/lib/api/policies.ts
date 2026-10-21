import { api } from '@/lib/api';

// Políticas por empresa/filial, horário de funcionamento e cadastro da empresa (API: /policies, /business-hours,
// /company-profile). A API é a autoridade: valida valores, permissões e grava histórico/auditoria.

export type PolicySource = 'DEFAULT' | 'COMPANY' | 'BRANCH';
export type PolicyGroup =
  | 'EMPRESA'
  | 'DESCONTO'
  | 'CAIXA'
  | 'ORCAMENTO'
  | 'AGENDA'
  | 'GARANTIA'
  | 'CONVENIO_FUNCIONARIO'
  | 'CONVENIO_EMPRESA'
  | 'COBRANCA'
  | 'FISCAL';

export interface PolicyRow {
  key: string;
  group: PolicyGroup;
  label: string;
  description: string;
  branchOverridable: boolean;
  default: unknown;
  companyValue: unknown;
  effective: unknown;
  source: PolicySource;
}

export interface PolicyChange {
  id: string;
  key: string;
  branchId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  changedBy: string;
  createdAt: string;
}

export interface BusinessDay {
  weekday: number;
  isClosed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  breakStart: string | null;
  breakEnd: string | null;
}

export interface CalendarException {
  id: string;
  branchId: string | null;
  date: string;
  kind: 'HOLIDAY' | 'CLOSED' | 'SPECIAL_HOURS';
  opensAt: string | null;
  closesAt: string | null;
  description: string | null;
}

export interface BusinessSchedule {
  branchId: string | null;
  source: 'BRANCH' | 'COMPANY' | 'NONE';
  days: BusinessDay[];
  companyDays: BusinessDay[];
  exceptions: CalendarException[];
  timezone: string;
}

export interface CompanyProfile {
  id: string;
  name: string;
  legalName: string | null;
  document: string;
  stateRegistration: string | null;
  municipalRegistration: string | null;
  taxRegime: 'SIMPLES_NACIONAL' | 'SIMPLES_NACIONAL_EXCESSO' | 'REGIME_NORMAL' | 'MEI' | null;
  email: string;
  phone: string | null;
  whatsapp: string | null;
  contactName: string | null;
  zipCode: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
}

const withBranch = (branchId?: string | null) => (branchId ? { params: { branchId } } : undefined);

export const policiesApi = {
  async effective(branchId?: string | null): Promise<{ values: Record<string, unknown>; sources: Record<string, PolicySource> }> {
    return (await api.http.get('/policies/effective', withBranch(branchId))).data;
  },
  async catalog(branchId?: string | null): Promise<PolicyRow[]> {
    return (await api.http.get('/policies', withBranch(branchId))).data.policies;
  },
  async history(params: { key?: string; branchId?: string | 'company' } = {}): Promise<PolicyChange[]> {
    return (await api.http.get('/policies/history', { params })).data.changes;
  },
  async set(key: string, body: { value: unknown; branchId?: string | null; reason: string }) {
    return (await api.http.put(`/policies/${encodeURIComponent(key)}`, body)).data;
  },
  async reset(key: string, body: { branchId?: string | null; reason: string }) {
    return (await api.http.delete(`/policies/${encodeURIComponent(key)}`, { params: body.branchId ? { branchId: body.branchId } : undefined, data: { reason: body.reason } })).data;
  },
};

export const businessHoursApi = {
  async get(branchId?: string | null): Promise<BusinessSchedule> {
    return (await api.http.get('/business-hours', withBranch(branchId))).data;
  },
  async setWeek(body: { branchId?: string | null; days: BusinessDay[] }) {
    return (await api.http.put('/business-hours', body)).data;
  },
  async clearBranch(branchId: string) {
    return (await api.http.delete('/business-hours', { params: { branchId } })).data;
  },
  async addException(body: { branchId?: string | null; date: string; kind: CalendarException['kind']; opensAt?: string | null; closesAt?: string | null; description?: string | null }) {
    return (await api.http.post('/business-hours/exceptions', body)).data;
  },
  async removeException(id: string) {
    return (await api.http.delete(`/business-hours/exceptions/${id}`)).data;
  },
};

export const companyProfileApi = {
  async get(): Promise<CompanyProfile> {
    return (await api.http.get('/company-profile')).data;
  },
  async update(body: Partial<CompanyProfile>): Promise<{ profile: CompanyProfile; changed: string[] }> {
    return (await api.http.put('/company-profile', body)).data;
  },
};
