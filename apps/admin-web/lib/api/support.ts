import { api } from '@/lib/api';
import type { AuthorRole, SupportCatalog, SupportStatus } from '@/lib/support';

// Central de Ajuda e Suporte (API: /support e /support-kb). Empresa, filial e usuário NÃO são enviados — a API tira do
// token. O contexto vai só como referência (tipo + id) e o servidor confere na empresa de quem abre. Cada escrita leva
// Idempotency-Key própria (duplo clique não abre dois chamados).

export const ADMIN_WEB_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const write = () => ({ headers: { 'Idempotency-Key': newKey(), 'X-Client-Source': 'ADMIN_WEB', 'X-App-Version': ADMIN_WEB_VERSION } });

export interface TicketContext {
  module?: string;
  moduleLabel?: string;
  screen?: string;
  route?: string;
  terminal?: string;
  entityType?: string;
  entityTypeLabel?: string;
  entityId?: string;
  label?: string;
  details?: Record<string, unknown>;
}

export interface TicketSummary {
  id: string;
  ticketNumber: number;
  subject: string;
  module: string;
  moduleLabel: string;
  type: string;
  typeLabel: string;
  priority: string;
  priorityLabel: string;
  status: SupportStatus;
  statusLabel: string;
  source: string;
  sourceLabel: string;
  requester: { id: string; name: string; role: string };
  company: { id: string; name: string | null };
  branch: { id: string; name: string | null } | null;
  assignedTo: { id: string; name: string | null } | null;
  context: TicketContext | null;
  appVersion: string | null;
  lastMessageAt: string;
  lastMessageBy: string;
  createdAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  unread?: boolean;
}

export interface TicketMessage {
  id: string;
  author: { id: string; name: string; role: AuthorRole };
  body: string;
  statusFrom: string | null;
  statusTo: string | null;
  source: string | null;
  createdAt: string;
}

export interface TicketEventRow {
  id: string;
  type: string;
  fromValue: string | null;
  toValue: string | null;
  actor: { id: string; name: string; role: string };
  createdAt: string;
}

export interface TicketAttachment {
  id: string;
  messageId: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedBy: { id: string; name: string };
  createdAt: string;
  removed: boolean;
}

export interface TicketDetail {
  ticket: TicketSummary & { description: string; requesterEmail: string | null; requesterPhone: string | null };
  messages: TicketMessage[];
  hasMoreMessages: boolean;
  events: TicketEventRow[];
  attachments: TicketAttachment[];
}

export interface KbArticleSummary {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  module: string | null;
  moduleLabel: string | null;
  category: { slug: string; name: string };
}

export interface KbArticle extends Omit<KbArticleSummary, 'category'> {
  body: string;
  keywords: string | null;
  category: { id: string; slug: string; name: string };
  publishedAt: string | null;
  updatedAt: string;
}

export interface NewTicketPayload {
  subject: string;
  module: string;
  type: string;
  priority?: string;
  description: string;
  context?: { screen?: string; route?: string; entityType?: string; entityId?: string };
}

let catalogPromise: Promise<SupportCatalog> | null = null;

/** Lê um arquivo do navegador como base64 (sem o prefixo data:). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ''));
    reader.readAsDataURL(file);
  });
}

export const supportApi = {
  catalog(): Promise<SupportCatalog> {
    if (!catalogPromise) {
      catalogPromise = api.http.get('/support-kb/catalog').then((r) => r.data);
      catalogPromise.catch(() => {
        catalogPromise = null;
      });
    }
    return catalogPromise;
  },
  async categories(): Promise<Array<{ id: string; slug: string; name: string; articles: number }>> {
    return (await api.http.get('/support-kb/categories')).data;
  },
  async searchArticles(params: { q?: string; category?: string; module?: string; limit?: number }): Promise<KbArticleSummary[]> {
    return (await api.http.get('/support-kb/articles', { params })).data;
  },
  async article(slug: string): Promise<KbArticle> {
    return (await api.http.get(`/support-kb/articles/${encodeURIComponent(slug)}`)).data;
  },

  async list(params: { status?: string; q?: string; page?: number; limit?: number }): Promise<{
    data: TicketSummary[];
    pagination: { page: number; limit: number; total: number; pages: number };
    companyWide: boolean;
  }> {
    return (await api.http.get('/support/tickets', { params })).data;
  },
  async unreadCount(): Promise<number> {
    return (await api.http.get('/support/tickets/unread-count')).data?.unread ?? 0;
  },
  async contextPreview(entityType: string, entityId: string): Promise<{ label: string; entityTypeLabel: string; details: Record<string, unknown> }> {
    return (await api.http.get('/support/context', { params: { entityType, entityId } })).data;
  },
  async create(body: NewTicketPayload): Promise<TicketSummary> {
    return (await api.http.post('/support/tickets', body, write())).data;
  },
  async get(id: string, before?: string): Promise<TicketDetail> {
    return (await api.http.get(`/support/tickets/${id}`, { params: before ? { before } : {} })).data;
  },
  async reply(id: string, body: string): Promise<{ id: string; status: SupportStatus }> {
    return (await api.http.post(`/support/tickets/${id}/messages`, { body }, write())).data;
  },
  async close(id: string) {
    return (await api.http.post(`/support/tickets/${id}/close`, {}, write())).data;
  },
  async reopen(id: string) {
    return (await api.http.post(`/support/tickets/${id}/reopen`, {}, write())).data;
  },
  async attach(id: string, file: File, messageId?: string): Promise<TicketAttachment> {
    const contentBase64 = await fileToBase64(file);
    return (await api.http.post(`/support/tickets/${id}/attachments`, { fileName: file.name, mimeType: file.type || undefined, contentBase64, ...(messageId ? { messageId } : {}) }, write())).data;
  },
  async removeAttachment(attachmentId: string) {
    return (await api.http.delete(`/support/attachments/${attachmentId}`)).data;
  },
  /** Download com o token no cabeçalho (nunca na URL); o arquivo é salvo pelo navegador, não aberto como página. */
  async download(a: Pick<TicketAttachment, 'id' | 'fileName'>): Promise<void> {
    const res = await api.http.get(`/support/attachments/${a.id}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data as Blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = a.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
};
