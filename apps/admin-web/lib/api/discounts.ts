import { api } from '@/lib/api';

// Desconto da OS e consulta de descontos concedidos (API: /service-orders/:id/discount, /discount-events).
// A API é a autoridade: limite livre por tipo (política), autorização de outra pessoa, motivo e registro em discount_events
// (docs/CORTEX/policies/DESCONTO.md).

export interface DiscountEvent {
  id: string;
  saleId: string | null;
  serviceOrderId: string | null;
  itemRef: string | null;
  itemType: 'PRODUCT' | 'PART' | 'SERVICE' | 'ORDER';
  description: string | null;
  originalAmount: number | string;
  discountAmount: number | string;
  discountPercent: number | string;
  finalAmount: number | string;
  freeLimitPercent: number | string;
  requiredAuthorization: boolean;
  requestedBy: string;
  requestedByName?: string | null;
  authorizedBy: string | null;
  authorizedByName?: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ServiceOrderDiscountState {
  serviceOrderId: string;
  partsTotal: number;
  laborTotal: number;
  discountAmount: number;
  finalTotal: number;
  partsDiscount: number;
  laborDiscount: number;
  editable: boolean;
  events: DiscountEvent[];
}

export interface ApplyServiceOrderDiscountBody {
  partsDiscount: number;
  laborDiscount: number;
  reason?: string;
  authorizerNumericId?: number;
  authorizerPassword?: string;
  authorizerMfaCode?: string;
}

/** Dados do 409 DISCOUNT_AUTHORIZATION_REQUIRED (limite livre vigente, percentual pedido, tipo). */
export interface DiscountAuthorizationDetails {
  freeLimitPercent: number | null;
  requestedPercent: number;
  itemType: DiscountEvent['itemType'];
  violations?: Array<{ itemType: string; freeLimitPercent: number | null; requestedPercent: number; source: 'POLICY' | 'DISCOUNT_RULE' }>;
  authorizerRoles?: string[];
}

export function discountAuthorizationDetails(err: unknown): DiscountAuthorizationDetails | null {
  const data = (err as any)?.response?.data;
  if ((err as any)?.response?.status === 409 && data?.code === 'DISCOUNT_AUTHORIZATION_REQUIRED') {
    return (data.details ?? { freeLimitPercent: null, requestedPercent: 0, itemType: 'ORDER' }) as DiscountAuthorizationDetails;
  }
  return null;
}

export const ITEM_TYPE_LABEL: Record<DiscountEvent['itemType'], string> = {
  PRODUCT: 'Produto',
  PART: 'Peças',
  SERVICE: 'Mão de obra',
  ORDER: 'Desconto geral',
};

export const discountsApi = {
  async serviceOrder(id: string): Promise<ServiceOrderDiscountState> {
    return (await api.http.get(`/service-orders/${id}/discount`)).data;
  },
  async applyToServiceOrder(id: string, body: ApplyServiceOrderDiscountBody) {
    return (await api.http.post(`/service-orders/${id}/discount`, body)).data;
  },
  async events(params: { saleId?: string; serviceOrderId?: string; from?: string; to?: string; limit?: number } = {}): Promise<DiscountEvent[]> {
    return (await api.http.get('/discount-events', { params })).data.data;
  },
};
