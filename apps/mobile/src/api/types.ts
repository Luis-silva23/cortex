// Formas mínimas dos contratos REAIS da API (apps/api/src/routes,
// apps/api/src/services/auth.service.ts) que este app consome — mantidas
// aqui (não importadas de @ln-system/shared) porque o pacote shared puxa
// bcrypt/jsonwebtoken (só Node, quebram o bundler do Metro/RN). Duplicar só
// as formas de resposta é o trade-off certo para um app cliente novo.

export interface SessionUser {
  id: string;
  numericId?: number;
  name: string;
  email?: string;
  userType: string;
  companyId?: string;
  branchId?: string;
  company?: { id: string; name: string; document: string; phone?: string };
  branch?: { id: string; name: string; address?: string; phone?: string };
}

export interface LoginSuccess {
  success: true;
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

export interface MfaRequired {
  success: true;
  mfaRequired: true;
  mfaToken: string;
  message: string;
}

export type LoginResponse = LoginSuccess | MfaRequired;

export function isMfaRequired(res: LoginResponse): res is MfaRequired {
  return 'mfaRequired' in res && res.mfaRequired === true;
}

export interface FollowUpDashboard {
  upcomingRevisions: number;
  scheduled: number;
  cancelled: number;
}

export interface AppointmentListItem {
  id: string;
  status: 'PROPOSED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
  scheduledAt: string;
  customerConfirmed: boolean;
  notes?: string;
  customer?: { id: string; name: string; phone?: string };
  motorcycle?: { id: string; brand: string; model: string; licensePlate?: string };
  /** Capacidade da agenda (2026-09-28): duração prevista (vazio = padrão da filial) e a efetiva calculada pela API. */
  durationMinutes?: number | null;
  effectiveDurationMinutes?: number;
  mechanicId?: string | null;
  mechanic?: { id: string; name: string | null } | null;
}

export interface Paginated {
  pagination: { page: number; limit: number; total: number; pages: number };
}

export interface AppointmentsList extends Paginated {
  appointments: AppointmentListItem[];
}

export interface ServiceOrderListItem {
  id: string;
  osNumber: number;
  status: string;
  entryKilometer: number;
  createdAt: string;
  customer?: { id: string; name: string; phone?: string };
  motorcycle?: { id: string; brand: string; model: string; licensePlate?: string };
}

// service-order.service.ts::list() retorna `orders`, não `serviceOrders` —
// nome mantido igual ao contrato real para não confundir quem for ler os
// dois lados lado a lado.
export interface ServiceOrdersList extends Paginated {
  orders: ServiceOrderListItem[];
}

export interface ServiceOrderItem {
  id: string;
  itemType: 'SERVICE' | 'PART';
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface ServiceOrderStatusHistoryEntry {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedAt: string;
  notes?: string;
}

// getById() inclui customer/motorcycle/items/statusHistory (ver
// service-order.service.ts) — o mobile só precisa do essencial pra uma
// tela de leitura, não os campos financeiros administrativos completos
// que a tela de Oficina do admin-web mostra.
export interface ServiceOrderDetail extends ServiceOrderListItem {
  laborTotal: number;
  partsTotal: number;
  finalTotal: number;
  isPaid: boolean;
  items: ServiceOrderItem[];
  statusHistory: ServiceOrderStatusHistoryEntry[];
}
