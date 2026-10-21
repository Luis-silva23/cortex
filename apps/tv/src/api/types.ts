// Mesma justificativa de apps/mobile/src/api/types.ts: formas duplicadas
// aqui (não importadas de @ln-system/shared, que puxa bcrypt/jsonwebtoken —
// só Node, quebram o bundler do Metro/RN) em vez de um pacote compartilhado
// novo — o app painel é pequeno o bastante para o trade-off valer a pena.

export interface SessionUser {
  id: string;
  name: string;
  userType: string;
  companyId?: string;
  branchId?: string;
  company?: { id: string; name: string };
  branch?: { id: string; name: string };
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

export interface AppointmentListItem {
  id: string;
  status: 'PROPOSED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
  scheduledAt: string;
  customerConfirmed: boolean;
  customer?: { id: string; name: string };
  motorcycle?: { id: string; brand: string; model: string; licensePlate?: string };
}

export interface AppointmentsList {
  appointments: AppointmentListItem[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

export interface ServiceOrderListItem {
  id: string;
  osNumber: number;
  status: string;
  createdAt: string;
  customer?: { id: string; name: string };
  motorcycle?: { id: string; brand: string; model: string; licensePlate?: string };
}

export interface ServiceOrdersList {
  orders: ServiceOrderListItem[];
  pagination: { page: number; limit: number; total: number; pages: number };
}
