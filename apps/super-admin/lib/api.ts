import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para adicionar token JWT
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// As rotas devolvem erro em formatos diferentes (`{ error }`, `{ message, code }` e, no login,
// `{ error: 'Unauthorized', message: 'Credenciais inválidas' }`): o texto útil nem sempre está em `error`.
const GENERIC_HTTP_ERROR = /^(Unauthorized|Forbidden|Bad Request|Not Found|Conflict|Too Many Requests|Internal Server Error)$/i;
export function apiErrorMessage(data: any, fallback = 'Erro desconhecido'): string {
  if (!data) return fallback;
  if (typeof data.message === 'string' && (typeof data.error !== 'string' || GENERIC_HTTP_ERROR.test(data.error))) {
    return data.message;
  }
  if (typeof data.error === 'string') return data.error;
  if (typeof data.message === 'string') return data.message;
  return fallback;
}

// Chamadas de autenticação NUNCA passam pelo "renovar e repetir": um 401 de /auth/login é senha errada,
// não sessão expirada. Antes disparava um refresh sem token, limpava tudo e RECARREGAVA a página em /login —
// o formulário esvaziava e o usuário nunca via o motivo (reproduzido na tela).
const AUTH_PATHS = ['/auth/login', '/auth/verify-mfa', '/auth/refresh', '/auth/logout'];

// Renovação compartilhada (single-flight): com várias requisições em 401 ao mesmo tempo (o dashboard dispara
// várias), cada uma renovava por conta própria; a API rotaciona o refresh a cada uso, então a 2ª reapresentava
// um token já revogado e a API interpretava como roubo, revogando TODAS as sessões.
let refreshInFlight: Promise<string> | null = null;
function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) throw new Error('No refresh token');

      const response = await axios.post(`${API_URL}/api/auth/refresh`, { refreshToken });
      const { accessToken, refreshToken: newRefreshToken } = response.data;
      localStorage.setItem('accessToken', accessToken);
      if (newRefreshToken) localStorage.setItem('refreshToken', newRefreshToken);
      return accessToken as string;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Interceptor para refresh token
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthCall = AUTH_PATHS.some((p) => String(originalRequest?.url || '').includes(p));

    // Se erro 401, não é uma chamada de autenticação e não é retry
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isAuthCall) {
      originalRequest._retry = true;

      try {
        const accessToken = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Limpar tokens e redirecionar para login
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;

// ============================================
// Observabilidade da plataforma (SUPER_ADMIN) — /api/observability/*
// Consumido apenas por app/dashboard/observability/**
// ============================================

export interface ObservabilityMetricsParams {
  startDate?: string;
  endDate?: string;
  route?: string;
}

export interface ObservabilitySecurityParams {
  startDate?: string;
  endDate?: string;
}

export interface ObservabilityLogsParams {
  startDate?: string;
  endDate?: string;
  level?: string;
  category?: string;
  service?: string;
  event?: string;
  requestId?: string;
  userId?: string;
  companyId?: string;
  branchId?: string;
  device?: string;
  page?: number;
  limit?: number;
}

export interface ObservabilityRequestLogsParams {
  startDate?: string;
  endDate?: string;
  route?: string;
  statusCode?: number;
  method?: string;
  requestId?: string;
  companyId?: string;
  branchId?: string;
  userId?: string;
  device?: string;
  page?: number;
  limit?: number;
}

export const observabilityApi = {
  getMetrics: (params: ObservabilityMetricsParams) =>
    api.get('/observability/metrics', { params }),
  getJobs: () => api.get('/observability/jobs'),
  getHealth: () => api.get('/observability/health'),
  getSecurity: (params: ObservabilitySecurityParams) =>
    api.get('/observability/security', { params }),
  getIntegrations: (params: ObservabilitySecurityParams) =>
    api.get('/observability/integrations', { params }),
  getSystemLogs: (params: ObservabilityLogsParams) =>
    api.get('/observability/logs/system', { params }),
  getSystemLogById: (id: string) => api.get(`/observability/logs/system/${id}`),
  getRequestLogs: (params: ObservabilityRequestLogsParams) =>
    api.get('/observability/logs/requests', { params }),
  getAlerts: () => api.get('/observability/alerts'),
};

// ============================================
// Monitoramento — /api/monitoring/* (Empresas → empresa → filiais → filial)
// ============================================
export type HealthStatus = 'NORMAL' | 'ATTENTION' | 'CRITICAL' | 'OFFLINE' | 'NO_DATA';
export type MonitoringRange = '1h' | '6h' | '24h' | '7d' | '30d';

export const monitoringApi = {
  companyHealth: (companyId: string) => api.get(`/monitoring/companies/${companyId}/health`),
  branchHealth: (companyId: string, branchId: string) => api.get(`/monitoring/companies/${companyId}/branches/${branchId}/health`),
  series: (companyId: string, branchId: string, range: MonitoringRange) =>
    api.get(`/monitoring/companies/${companyId}/branches/${branchId}/series`, { params: { range } }),
  endpoints: (companyId: string, branchId: string, range: MonitoringRange) =>
    api.get(`/monitoring/companies/${companyId}/branches/${branchId}/endpoints`, { params: { range } }),
  incidents: (companyId: string, branchId?: string) =>
    api.get(`/monitoring/companies/${companyId}/incidents`, { params: branchId ? { branchId } : undefined }),
  alerts: (companyId: string, params: { branchId?: string; open?: boolean } = {}) =>
    api.get(`/monitoring/companies/${companyId}/alerts`, { params: { ...(params.branchId ? { branchId: params.branchId } : {}), ...(params.open ? { open: 'true' } : {}) } }),
  centralAlerts: (open = true) => api.get('/monitoring/central/alerts', { params: open ? { open: 'true' } : undefined }),
  thresholds: (scope: ThresholdScope) => api.get('/monitoring/thresholds', { params: scopeParams(scope) }),
  thresholdHistory: (companyId?: string) => api.get('/monitoring/thresholds/history', { params: companyId ? { companyId } : undefined }),
  setThreshold: (scope: ThresholdScope, body: { metric: string; attention: number; critical: number; reason: string }) =>
    api.put('/monitoring/thresholds', { ...scopeParams(scope), ...body }),
  resetThreshold: (scope: ThresholdScope, body: { metric: string; reason: string }) =>
    api.delete('/monitoring/thresholds', { data: { ...scopeParams(scope), ...body } }),
};

// ============================================
// Central de Monitoramento — /api/monitoring/central/* (SÓ Super Admin no backend)
// ============================================
export type CentralRange = MonitoringRange;
export type AlertAction = 'ACKNOWLEDGE' | 'ASSIGN' | 'START' | 'RESOLVE' | 'REOPEN' | 'NOTE';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLVED';

export interface CompaniesQuery {
  range?: CentralRange;
  q?: string;
  lifecycle?: string;
  severity?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}
export interface AlertsQuery {
  status?: string;
  severity?: string;
  category?: string;
  companyId?: string;
  scope?: string;
  q?: string;
  page?: number;
  limit?: number;
}
export interface InfrastructureQuery {
  range?: CentralRange;
  /** Chave do serviço (ex.: DATABASE, EXT_MINHA_API). */
  service?: string;
  severity?: string;
  /** OPEN | RESOLVED */
  state?: string;
  /** technical | operational */
  scope?: string;
}
const clean = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const centralApi = {
  meta: () => api.get('/monitoring/central/meta'),
  infrastructure: (q: InfrastructureQuery) => api.get('/monitoring/central/infrastructure', { params: clean(q) }),
  overview: (range: CentralRange) => api.get('/monitoring/central/overview', { params: { range } }),
  series: (range: CentralRange) => api.get('/monitoring/central/series', { params: { range } }),
  companies: (q: CompaniesQuery) => api.get('/monitoring/central/companies', { params: clean(q) }),
  company: (id: string, params: { range?: CentralRange; module?: string; severity?: string }) => api.get(`/monitoring/central/companies/${id}`, { params: clean(params) }),
  alerts: (q: AlertsQuery) => api.get('/monitoring/central/alert-center', { params: clean(q) }),
  alert: (id: string) => api.get(`/monitoring/central/alert-center/${id}`),
  assignees: () => api.get('/monitoring/central/alert-center/assignees'),
  alertAction: (id: string, body: { action: AlertAction; note?: string; assigneeId?: string | null }) => api.post(`/monitoring/central/alert-center/${id}/actions`, body),
  funnel: () => api.get('/monitoring/central/funnel'),
  leads: (q: { stage?: string; q?: string; page?: number; limit?: number }) => api.get('/monitoring/central/funnel/leads', { params: clean(q) }),
  createLead: (body: { name: string; contact?: string; source?: string; stage?: string; companyId?: string }) => api.post('/monitoring/central/funnel/leads', body),
  moveLead: (id: string, stage: string, note?: string) => api.post(`/monitoring/central/funnel/leads/${id}/move`, { stage, note }),
  linkLead: (id: string, companyId: string) => api.post(`/monitoring/central/funnel/leads/${id}/link-company`, { companyId }),
  external: () => api.get('/monitoring/central/external'),
  checkResend: () => api.post('/monitoring/central/external/resend/check'),
  settings: () => api.get('/monitoring/central/settings'),
  saveSettings: (body: { toggles?: Record<string, boolean | null>; limits?: Record<string, number | null> }) => api.put('/monitoring/central/settings', body),
};

/** Escopo de um limite: global (nenhum), empresa, ou filial da empresa. */
export interface ThresholdScope {
  companyId?: string | null;
  branchId?: string | null;
}
const scopeParams = (s: ThresholdScope) => ({ ...(s.companyId ? { companyId: s.companyId } : {}), ...(s.branchId ? { branchId: s.branchId } : {}) });

export interface MonitoringThresholdRow {
  metric: string;
  label: string;
  unit: string;
  attention: number;
  critical: number;
  source: 'DEFAULT' | 'GLOBAL' | 'COMPANY' | 'BRANCH';
  defaults: { attention: number; critical: number };
  bounds: { min: number; max: number };
}

export interface MonitoringAlert {
  id: string;
  source: 'BRANCH' | 'DEVICE' | 'CENTRAL';
  branchId: string | null;
  deviceId: string | null;
  type: string;
  metric: string;
  severity: HealthStatus;
  value: number | null;
  threshold: number | null;
  detail: string | null;
  occurrences: number;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
}

// ============================================
// Auditoria — /api/audit-logs/* (Super Admin vê todas as empresas;
// Company Admin/Manager só a própria — este painel é o do Super Admin,
// então sempre sem filtro forçado de empresa, mas o parâmetro companyId
// continua disponível para filtrar por uma empresa específica).
// Consumido apenas por app/dashboard/audit-logs/**
// ============================================

export interface AuditLogsParams {
  companyId?: string;
  userId?: string;
  action?: string;
  entity?: string;
  entityId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export const auditApi = {
  list: (params: AuditLogsParams) => api.get('/audit-logs', { params }),
  getById: (id: string) => api.get(`/audit-logs/${id}`),
  getForEntity: (entity: string, entityId: string) => api.get(`/audit-logs/entity/${entity}/${entityId}`),
};

// Backup é uma operação de plataforma (todo o banco, não escopada a uma
// empresa) — por isso vive no Super Admin, não em admin-web (que já tem
// sua própria aba "Backup" em Configurações, mas chamando a MESMA rota;
// não há isolamento por empresa no backup do banco inteiro). Ver
// TASK-003: `POST /api/backup/create` hoje falha de verdade neste
// ambiente (FORCE ROW LEVEL SECURITY — falta um papel Postgres com
// BYPASSRLS, que exige superusuário) — esta API só expõe o que o backend
// realmente responde, nunca simula sucesso.
export const backupApi = {
  create: () => api.post('/backup/create'),
  list: () => api.get('/backup/list'),
  stats: () => api.get('/backup/stats'),
  restore: (filename: string) => api.post('/backup/restore', { filename }),
  remove: (filename: string) => api.delete(`/backup/delete/${encodeURIComponent(filename)}`),
};

// ============================================
// Console de Suporte da plataforma — /api/support-admin/* (docs/CORTEX/SUPPORT.md)
// Consumido apenas por app/dashboard/support/**. As respostas vêm sem envelope (`res.data` já é o objeto).
// ============================================

export interface SupportTicketListParams {
  status?: string;
  q?: string;
  companyId?: string;
  branchId?: string;
  module?: string;
  type?: string;
  priority?: string;
  assignedToId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface SupportKbArticleInput {
  title?: string;
  summary?: string | null;
  body?: string;
  keywords?: string | null;
  module?: string | null;
  categoryId?: string;
  slug?: string;
}

const idem = (key: string) => ({ headers: { 'Idempotency-Key': key } });

export const supportAdminApi = {
  catalog: () => api.get('/support-admin/catalog'),
  dashboard: () => api.get('/support-admin/dashboard'),
  agents: () => api.get('/support-admin/agents'),
  companies: () => api.get('/support-admin/companies'),
  tickets: (params: SupportTicketListParams) => api.get('/support-admin/tickets', { params }),
  ticket: (id: string, params?: { before?: string }) => api.get(`/support-admin/tickets/${encodeURIComponent(id)}`, { params }),
  reply: (id: string, body: { body: string; status?: string }, idempotencyKey: string) =>
    api.post(`/support-admin/tickets/${encodeURIComponent(id)}/messages`, body, idem(idempotencyKey)),
  assign: (id: string, assigneeId: string | null) => api.post(`/support-admin/tickets/${encodeURIComponent(id)}/assign`, { assigneeId }),
  setStatus: (id: string, status: string) => api.post(`/support-admin/tickets/${encodeURIComponent(id)}/status`, { status }),
  setPriority: (id: string, priority: string) => api.post(`/support-admin/tickets/${encodeURIComponent(id)}/priority`, { priority }),
  addAttachment: (
    id: string,
    body: { fileName: string; mimeType: string; contentBase64: string; messageId?: string },
    idempotencyKey: string
  ) => api.post(`/support-admin/tickets/${encodeURIComponent(id)}/attachments`, body, idem(idempotencyKey)),
  // Download com o cabeçalho Authorization (blob) — o token nunca vai na URL.
  downloadAttachment: (id: string) => api.get(`/support-admin/attachments/${encodeURIComponent(id)}`, { responseType: 'blob' }),
  removeAttachment: (id: string) => api.delete(`/support-admin/attachments/${encodeURIComponent(id)}`),

  kbArticles: (params: { status?: string; category?: string; q?: string }) => api.get('/support-admin/kb/articles', { params }),
  kbArticle: (id: string) => api.get(`/support-admin/kb/articles/${encodeURIComponent(id)}`),
  kbCreateArticle: (body: SupportKbArticleInput) => api.post('/support-admin/kb/articles', body),
  kbUpdateArticle: (id: string, body: SupportKbArticleInput) => api.patch(`/support-admin/kb/articles/${encodeURIComponent(id)}`, body),
  kbSetArticleStatus: (id: string, status: 'PUBLISHED' | 'DRAFT') =>
    api.post(`/support-admin/kb/articles/${encodeURIComponent(id)}/status`, { status }),
  kbCategories: () => api.get('/support-admin/kb/categories'),
  kbCreateCategory: (body: { name: string; sortOrder?: number; isActive?: boolean }) => api.post('/support-admin/kb/categories', body),
  kbUpdateCategory: (id: string, body: { name?: string; sortOrder?: number; isActive?: boolean }) =>
    api.patch(`/support-admin/kb/categories/${encodeURIComponent(id)}`, body),
};
