import { api } from '@/lib/api';
import type {
  AllowedActions,
  ClosePayload,
  CreateReturnPayload,
  SupplierReturnOutcome,
  SupplierReturnReason,
  SupplierReturnStatus,
} from '@/lib/supplier-returns';

// Devolução ao fornecedor (API: /supplier-returns). A API decide política, saldo, transição e permissões; cada escrita
// leva uma Idempotency-Key própria (duplo clique não repete a ação).

export interface SupplierReturnItem {
  id: string;
  productId: string;
  quantity: string | number;
  unitCost: string | number | null;
  notes: string | null;
  damageRecordId: string | null;
  product: { id: string; name: string; sku: string; unit?: string };
}

export interface SupplierReturnEvent {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  userId: string;
  userName: string | null;
  notes: string | null;
  createdAt: string;
}

export interface SupplierReturnSummary {
  id: string;
  returnNumber: number;
  branchId: string;
  supplierId: string;
  status: SupplierReturnStatus;
  reason: SupplierReturnReason;
  description: string | null;
  outcome: SupplierReturnOutcome | null;
  outcomeAmount: string | number | null;
  createdAt: string;
  supplier?: { id: string; name: string };
  _count?: { items: number };
}

export interface SupplierReturnDetail extends SupplierReturnSummary {
  purchaseOrderId: string | null;
  purchaseOrder: { id: string; poNumber: number } | null;
  requestedBy: string;
  requestedByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  decisionNotes: string | null;
  stockWithdrawnAt: string | null;
  sentAt: string | null;
  sentByName: string | null;
  shippingInfo: string | null;
  outcomeNotes: string | null;
  closedAt: string | null;
  closedByName: string | null;
  supplier: { id: string; name: string; document?: string };
  items: SupplierReturnItem[];
  events: SupplierReturnEvent[];
  stockMovements: Array<{ id: string; productId: string; movementType: string; quantity: string | number; createdAt: string }>;
  approverRoles: string[];
  allowedActions: AllowedActions;
}

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const idem = () => ({ headers: { 'Idempotency-Key': newKey() } });

export const supplierReturnsApi = {
  async list(params: { status?: SupplierReturnStatus; supplierId?: string; page?: number; limit?: number } = {}): Promise<{
    returns: SupplierReturnSummary[];
    pagination: { page: number; limit: number; total: number; pages: number };
  }> {
    return (await api.http.get('/supplier-returns', { params })).data;
  },
  async get(id: string): Promise<SupplierReturnDetail> {
    return (await api.http.get(`/supplier-returns/${id}`)).data;
  },
  async create(body: CreateReturnPayload): Promise<SupplierReturnDetail> {
    return (await api.http.post('/supplier-returns', body, idem())).data;
  },
  async approve(id: string, notes?: string): Promise<SupplierReturnDetail> {
    return (await api.http.post(`/supplier-returns/${id}/approve`, notes ? { notes } : {}, idem())).data;
  },
  async reject(id: string, reason: string): Promise<SupplierReturnDetail> {
    return (await api.http.post(`/supplier-returns/${id}/reject`, { reason }, idem())).data;
  },
  async send(id: string, shippingInfo?: string): Promise<SupplierReturnDetail> {
    return (await api.http.post(`/supplier-returns/${id}/send`, shippingInfo ? { shippingInfo } : {}, idem())).data;
  },
  async close(id: string, body: ClosePayload): Promise<SupplierReturnDetail> {
    return (await api.http.post(`/supplier-returns/${id}/close`, body, idem())).data;
  },
  async cancel(id: string, reason: string): Promise<SupplierReturnDetail> {
    return (await api.http.post(`/supplier-returns/${id}/cancel`, { reason }, idem())).data;
  },
};
