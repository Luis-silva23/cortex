import { api } from '@/lib/api';
import type { WarrantyClaimStatus, WarrantyCoverage, WarrantyDecisionPayload, WarrantyDurationUnit } from '@/lib/warranty';

// Garantias de OS (API: /warranties e o encerramento em /service-orders/:id/status). A API é a autoridade: política,
// vigência (prazo/km), permissões e auditoria.

export interface WarrantyClaim {
  id: string;
  warrantyId: string;
  serviceOrderId: string;
  newServiceOrderId: string | null;
  description: string;
  kmAtClaim: string | number | null;
  status: WarrantyClaimStatus;
  decisionNotes: string | null;
  openedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface Warranty {
  id: string;
  serviceOrderId: string;
  customerId: string;
  motorcycleId: string;
  coverage: WarrantyCoverage;
  durationValue: number;
  durationUnit: WarrantyDurationUnit;
  durationLabel?: string;
  kmLimit: number | null;
  startDate: string;
  validUntil: string;
  startKm: string | number | null;
  kmUntil: string | number | null;
  coveredItems: Array<{ id: string; itemType: 'SERVICE' | 'PART'; description: string; quantity: number }> | null;
  conditions: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  status?: 'ACTIVE' | 'EXPIRED';
  expiredBy?: 'DATE' | 'KM' | null;
  evaluatedKm?: number | null;
  claims: WarrantyClaim[];
  serviceOrder?: {
    id: string;
    osNumber: number;
    customer?: { id: string; name: string; phone?: string | null; whatsapp?: string | null };
    motorcycle?: { id: string; brand: string; model: string; licensePlate?: string | null };
  };
}

export const warrantiesApi = {
  async list(params: { customerId?: string; motorcycleId?: string; status?: 'ACTIVE' | 'EXPIRED'; km?: number; limit?: number } = {}): Promise<{
    warranties: Warranty[];
    total: number;
  }> {
    return (await api.http.get('/warranties', { params })).data;
  },
  async get(id: string, km?: number): Promise<Warranty> {
    return (await api.http.get(`/warranties/${id}`, { params: km !== undefined ? { km } : undefined })).data;
  },
  async openClaim(id: string, body: { description: string; kmAtClaim?: number | null }): Promise<WarrantyClaim> {
    return (await api.http.post(`/warranties/${id}/claims`, body)).data;
  },
  async decideClaim(claimId: string, body: { status: 'ACCEPTED' | 'REJECTED' | 'RESOLVED'; decisionNotes: string; newServiceOrderId?: string | null }): Promise<WarrantyClaim> {
    return (await api.http.patch(`/warranties/claims/${claimId}`, body)).data;
  },
  /** Encerra a OS (ENCERRADA) com a decisão de garantia na mesma transação. */
  async closeServiceOrder(serviceOrderId: string, body: { warranty?: WarrantyDecisionPayload; notes?: string }) {
    return (await api.http.post(`/service-orders/${serviceOrderId}/status`, { toStatus: 'ENCERRADA', ...body })).data;
  },
};
