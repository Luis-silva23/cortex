// Formatos devolvidos por /api/support-admin/* (apps/api/src/services/support.service.ts e support-kb.service.ts).

export interface Option {
  value: string;
  label: string;
}

export interface StatusOption extends Option {
  open: boolean;
}

export interface SupportCatalog {
  modules: Option[];
  types: Option[];
  priorities: Option[];
  statuses: StatusOption[];
  sources: Option[];
  entityTypes: Option[];
  attachments: { maxBytes: number; perTicket: number; types: Record<string, string[]> };
}

export interface SupportDashboard {
  byStatus: { status: string; label: string; count: number }[];
  open: number;
  unassigned: number;
  waitingSupport: number;
}

export interface SupportAgent {
  id: string;
  name: string;
  email: string;
  openTickets: number;
}

export interface SupportCompany {
  id: string;
  name: string;
  tickets: number;
}

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
  details?: Record<string, unknown> | null;
}

export interface SupportTicket {
  id: string;
  ticketNumber: number;
  subject: string;
  module: string;
  moduleLabel: string;
  type: string;
  typeLabel: string;
  priority: string;
  priorityLabel: string;
  status: string;
  statusLabel: string;
  source: string;
  sourceLabel: string;
  requester: { id: string; name: string; role: string };
  company: { id: string; name: string };
  branch: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  context: TicketContext | null;
  appVersion: string | null;
  lastMessageAt: string;
  lastMessageBy: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
}

export interface SupportTicketRow extends SupportTicket {
  unreadForSupport: boolean;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export type AuthorRole = 'REQUESTER' | 'COMPANY' | 'SUPPORT';

export interface TicketMessage {
  id: string;
  author: { id: string; name: string; role: AuthorRole | string };
  body: string;
  statusFrom: string | null;
  statusTo: string | null;
  source: string | null;
  createdAt: string;
}

export interface TicketEvent {
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
  ticket: SupportTicket & { description: string; requesterEmail: string | null; requesterPhone: string | null };
  messages: TicketMessage[];
  hasMoreMessages: boolean;
  events: TicketEvent[];
  attachments: TicketAttachment[];
}

export interface KbCategory {
  id: string;
  slug: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  articles: number;
}

export interface KbArticle {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  keywords: string | null;
  module: string | null;
  moduleLabel: string | null;
  status: 'DRAFT' | 'PUBLISHED';
  category: { id: string; slug: string; name: string };
  author: { id: string; name: string };
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
