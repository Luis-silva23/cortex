import { api } from '@/lib/api';

// Conciliação de pagamentos — inconsistências de integração (API: /payments/exceptions). Ex.: o provedor aprovou o
// pagamento DEPOIS que a venda foi cancelada/devolvida. A venda nunca é reaberta nem vira paga, e o sistema não inventa
// crédito nem estorno: quem pode estornar escolhe "estorno no provedor" ou registra o tratamento manual com justificativa.

export interface IntegrationInconsistency {
  id: string;
  paymentId: string;
  saleId: string;
  branchId: string | null;
  type: string;
  saleStatus: string;
  amount: number | string;
  provider: string | null;
  providerStatus: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  notes: string | null;
  payment?: { id: string; paymentMethod?: string; transactionId?: string | null; status?: string; amount?: number | string } | null;
}

export const INCONSISTENCY_TYPE_LABEL: Record<string, string> = {
  APPROVED_ON_CLOSED_SALE: 'Aprovado pelo provedor com a venda já encerrada',
};

export const RESOLUTION_LABEL: Record<string, string> = {
  REFUNDED: 'Estornado no provedor',
  MANUAL: 'Tratado manualmente',
};

export const SALE_STATUS_LABEL: Record<string, string> = {
  CANCELLED: 'Cancelada',
  RETURNED: 'Devolvida',
  PENDING: 'Pendente',
  PAID: 'Paga',
  PARTIALLY_PAID: 'Parcialmente paga',
};

export const reconciliationApi = {
  async list(open?: boolean): Promise<IntegrationInconsistency[]> {
    return (await api.http.get('/payments/exceptions', { params: open ? { open: 'true' } : undefined })).data.data;
  },
  async resolve(id: string, body: { action: 'REFUND' | 'MANUAL'; note?: string }) {
    return (await api.http.post(`/payments/exceptions/${id}/resolve`, body)).data;
  },
};
