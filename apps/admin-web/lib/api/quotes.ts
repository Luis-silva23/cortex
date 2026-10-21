import { api } from '@/lib/api';
import type { QuoteItemPayload } from '@/lib/quotes';

// Orçamentos: vencidos, encerramento em lote, reabertura e orçamentos existentes por veículo (API: /quotes). A API é a
// autoridade (prazo por política, guarda de estado, auditoria); a tela só apresenta o resultado.

export type QuoteCloseOutcome = 'CLOSED' | 'ALREADY_CLOSED' | 'NOT_ALLOWED' | 'NOT_FOUND';

export interface QuoteCloseResult {
  id: string;
  quoteNumber: number | null;
  fromStatus: string | null;
  outcome: QuoteCloseOutcome;
  message: string;
}

export interface QuoteCloseResponse {
  reason: string;
  results: QuoteCloseResult[];
  summary: { closed: number; alreadyClosed: number; notAllowed: number; notFound: number };
}

export interface RelatedQuote {
  id: string;
  quoteNumber: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  overdue: boolean;
  respondBy: string | null;
  daysWithoutResponse: number | null;
  canReopen: boolean;
  versions: Array<{ versionNumber: number; totalAmount: number | string; sentAt: string | null }>;
}

export interface OpenQuoteConflict {
  code: 'OPEN_QUOTE_EXISTS';
  error: string;
  existingQuoteId: string;
  existingQuoteNumber: number;
  existingStatus: string;
}

/** 409 OPEN_QUOTE_EXISTS da criação/reabertura: devolve os dados do orçamento que já existe. */
export function openQuoteConflict(err: unknown): OpenQuoteConflict | null {
  const res = (err as any)?.response;
  return res?.status === 409 && res?.data?.code === 'OPEN_QUOTE_EXISTS' ? (res.data as OpenQuoteConflict) : null;
}

export const quotesApi = {
  async close(ids: string[], reason: string): Promise<QuoteCloseResponse> {
    return (await api.http.post('/quotes/close', { ids, reason })).data;
  },
  async reopen(id: string, reason: string) {
    return (await api.http.post(`/quotes/${id}/reopen`, { reason })).data;
  },
  async related(customerId: string, motorcycleId: string): Promise<{ open: RelatedQuote[]; closed: RelatedQuote[] }> {
    return (await api.http.get('/quotes/related', { params: { customerId, motorcycleId } })).data;
  },
  async list(params: { status?: string; overdue?: boolean; page?: number; limit?: number }) {
    return (await api.http.get('/quotes', { params: { ...params, overdue: params.overdue ? 'true' : undefined } })).data;
  },
  async create(quote: {
    branchId: string;
    customerId: string;
    motorcycleId: string;
    validUntil?: string;
    notes?: string;
    items: QuoteItemPayload[];
    confirmNew?: boolean;
  }) {
    return (await api.http.post('/quotes', quote)).data;
  },
};
