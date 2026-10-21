import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { AppError, ConflictError } from '@ln-system/shared';
import { getUserPermissions } from '../middleware/permission';
import {
  OPEN_STATUSES,
  SUPPORT_ENTITY_TYPES,
  SUPPORT_LIMITS,
  SUPPORT_MODULES,
  SUPPORT_PRIORITIES,
  SUPPORT_SETTABLE_STATUSES,
  SUPPORT_SOURCES,
  SUPPORT_STATUSES,
  SUPPORT_TYPES,
  type SupportEntityType,
  type SupportStatus,
} from './support-catalog';
import { validateAttachment } from './support-attachment';
import { containsCardNumber, SENSITIVE_DATA_MESSAGE } from './support-sensitive';

/**
 * Central de Ajuda e Suporte (docs/CORTEX/SUPPORT.md).
 *
 * Quem é quem:
 *  - SOLICITANTE: qualquer usuário de empresa abre e acompanha os PRÓPRIOS chamados (inclusive somente leitura: pedir
 *    ajuda não é escrita de negócio).
 *  - EMPRESA: quem tem `support:view_company` (padrão do administrador da empresa) vê e responde os chamados da empresa
 *    — preso a uma filial, só os da filial dele.
 *  - SUPORTE: a equipe da plataforma (SUPER_ADMIN), no console de suporte, com o contexto RLS de plataforma explícito.
 *
 * Empresa, filial e usuário vêm SEMPRE do token (req.user); nada disso é aceito do corpo. A RLS isola empresa/filial no
 * banco; o serviço filtra ainda por solicitante/permissão. Mensagens e histórico só crescem (RLS sem UPDATE/DELETE).
 */

export interface SupportActor {
  userId: string;
  userType: string;
  companyId?: string | null;
  branchId?: string | null;
}

const bad = (message: string, code: string) => new AppError(message, 400, code);
const notFound = () => new AppError('Chamado não encontrado. Confira o número ou volte para a lista de chamados.', 404, 'SUPPORT_TICKET_NOT_FOUND');
const keyOf = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];

// ---------------------------------------------------------------------------------------------------------- validação
const contextSchema = z
  .object({
    screen: z.string().trim().max(80).optional(),
    route: z.string().trim().max(200).optional(),
    terminal: z.string().trim().max(60).optional(),
    entityType: z.enum(keyOf(SUPPORT_ENTITY_TYPES)).optional(),
    entityId: z.string().uuid('Referência inválida').optional(),
  })
  .strict()
  .refine((c) => !!c.entityType === !!c.entityId, { message: 'Referência incompleta (tipo e id juntos)' });

export const createTicketSchema = z
  .object({
    subject: z.string().trim().min(3, 'Assunto: mínimo 3 caracteres').max(SUPPORT_LIMITS.subjectMax, `Assunto: no máximo ${SUPPORT_LIMITS.subjectMax} caracteres`),
    module: z.enum(keyOf(SUPPORT_MODULES), { errorMap: () => ({ message: 'Escolha o módulo na lista' }) }),
    type: z.enum(keyOf(SUPPORT_TYPES), { errorMap: () => ({ message: 'Escolha o tipo na lista' }) }),
    priority: z.enum(keyOf(SUPPORT_PRIORITIES), { errorMap: () => ({ message: 'Prioridade inválida' }) }).optional(),
    description: z.string().trim().min(10, 'Descreva o que aconteceu (mínimo 10 caracteres)').max(SUPPORT_LIMITS.descriptionMax),
    context: contextSchema.optional(),
  })
  .strict()
  .refine((d) => !containsCardNumber(`${d.subject}\n${d.description}`), { message: SENSITIVE_DATA_MESSAGE });

const messageSchema = z
  .object({ body: z.string().trim().min(1, 'Escreva a mensagem').max(SUPPORT_LIMITS.messageMax) })
  .refine((d) => !containsCardNumber(d.body), { message: SENSITIVE_DATA_MESSAGE });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    throw bad(first?.code === 'unrecognized_keys' ? 'Campo não aceito no pedido. Recarregue a página e tente de novo.' : first?.message ?? 'Dados inválidos', 'VALIDATION_ERROR');
  }
  return r.data;
}

// ---------------------------------------------------------------------------------------------------------- acesso
export async function canViewCompanyTickets(actor: SupportActor): Promise<boolean> {
  if (actor.userType === 'COMPANY_ADMIN') return true;
  if (!actor.companyId) return false;
  const granted = await getUserPermissions(actor.userId, actor.companyId, actor.branchId ?? null);
  return granted.includes('support:view_company');
}

/** Filtro do que o usuário de empresa enxerga (além da RLS). */
async function visibilityWhere(actor: SupportActor): Promise<Prisma.SupportTicketWhereInput> {
  if (!actor.companyId) throw new AppError('Abra a Central de Suporte pelo usuário da empresa.', 403, 'SUPPORT_COMPANY_REQUIRED');
  const companyWide = await canViewCompanyTickets(actor);
  if (!companyWide) return { companyId: actor.companyId, requesterId: actor.userId };
  return actor.branchId ? { companyId: actor.companyId, OR: [{ branchId: actor.branchId }, { requesterId: actor.userId }] } : { companyId: actor.companyId };
}

async function loadVisible(actor: SupportActor, id: string) {
  const where = await visibilityWhere(actor);
  const ticket = await prisma.supportTicket.findFirst({ where: { AND: [{ id }, where] } });
  if (!ticket) throw notFound();
  return ticket;
}

async function nameOf(userId: string) {
  const u = await prisma.user.findFirst({ where: { id: userId }, select: { name: true, email: true, phone: true } });
  return u ?? { name: 'Usuário', email: null, phone: null };
}

// ---------------------------------------------------------------------------------------------------------- contexto
/**
 * Confere a entidade citada no chamado NA EMPRESA/FILIAL de quem abre (consulta com o contexto RLS do usuário + filtro
 * de empresa) e devolve só um rótulo e detalhes não sensíveis. Entidade de outra empresa/filial ou inexistente: 400 —
 * a mesma resposta nos dois casos (não revela que existe).
 */
export async function resolveContext(actor: SupportActor, entityType: SupportEntityType, entityId: string) {
  const companyId = actor.companyId!;
  const notFoundCtx = () => bad('A referência deste chamado não foi encontrada na sua empresa. Abra o chamado a partir da tela correta.', 'SUPPORT_CONTEXT_NOT_FOUND');
  switch (entityType) {
    case 'SALE': {
      const s = await prisma.sale.findFirst({ where: { id: entityId, companyId }, select: { saleNumber: true, status: true } });
      if (!s) throw notFoundCtx();
      return { label: `Venda #${s.saleNumber}`, details: { saleNumber: s.saleNumber, status: String(s.status) } };
    }
    case 'PAYMENT': {
      const p = await prisma.payment.findFirst({ where: { id: entityId, companyId }, select: { paymentMethod: true, status: true, sale: { select: { saleNumber: true } } } });
      if (!p) throw notFoundCtx();
      return { label: `Pagamento da venda #${p.sale?.saleNumber ?? '—'}`, details: { saleNumber: p.sale?.saleNumber ?? null, paymentMethod: String(p.paymentMethod), status: String(p.status) } };
    }
    case 'SERVICE_ORDER': {
      const os = await prisma.serviceOrder.findFirst({
        where: { id: entityId, companyId },
        select: { osNumber: true, status: true, customer: { select: { name: true } }, motorcycle: { select: { brand: true, model: true, licensePlate: true } } },
      });
      if (!os) throw notFoundCtx();
      return {
        label: `OS #${os.osNumber}`,
        details: {
          osNumber: os.osNumber,
          status: String(os.status),
          customer: os.customer?.name ?? null,
          vehicle: os.motorcycle ? [os.motorcycle.brand, os.motorcycle.model, os.motorcycle.licensePlate].filter(Boolean).join(' ') : null,
        },
      };
    }
    case 'QUOTE': {
      const q = await prisma.quote.findFirst({ where: { id: entityId, companyId }, select: { quoteNumber: true, status: true } });
      if (!q) throw notFoundCtx();
      return { label: `Orçamento #${q.quoteNumber}`, details: { quoteNumber: q.quoteNumber, status: String(q.status) } };
    }
    case 'PRODUCT': {
      const p = await prisma.product.findFirst({ where: { id: entityId, companyId }, select: { name: true, sku: true } });
      if (!p) throw notFoundCtx();
      return { label: `Produto ${p.name}`, details: { name: p.name, sku: p.sku } };
    }
    case 'RECEIVABLE': {
      const r = await prisma.accountsReceivable.findFirst({ where: { id: entityId, companyId }, select: { description: true, status: true, dueDate: true } });
      if (!r) throw notFoundCtx();
      return { label: `Conta a receber — ${r.description}`, details: { description: r.description, status: String(r.status), dueDate: r.dueDate } };
    }
    case 'WARRANTY': {
      const w = await prisma.serviceOrderWarranty.findFirst({ where: { id: entityId, companyId }, select: { serviceOrderId: true } });
      if (!w) throw notFoundCtx();
      const os = await prisma.serviceOrder.findFirst({
        where: { id: w.serviceOrderId, companyId },
        select: { osNumber: true, customer: { select: { name: true } }, motorcycle: { select: { brand: true, model: true, licensePlate: true } } },
      });
      return {
        label: `Garantia da OS #${os?.osNumber ?? '—'}`,
        details: {
          osNumber: os?.osNumber ?? null,
          customer: os?.customer?.name ?? null,
          vehicle: os?.motorcycle ? [os.motorcycle.brand, os.motorcycle.model, os.motorcycle.licensePlate].filter(Boolean).join(' ') : null,
        },
      };
    }
    case 'APPOINTMENT': {
      const a = await prisma.appointment.findFirst({ where: { id: entityId, companyId }, select: { scheduledAt: true, status: true, customer: { select: { name: true } } } });
      if (!a) throw notFoundCtx();
      return { label: 'Agendamento', details: { scheduledAt: a.scheduledAt, status: String(a.status), customer: a.customer?.name ?? null } };
    }
    case 'SUPPLIER_RETURN': {
      const r = await prisma.supplierReturn.findFirst({ where: { id: entityId, companyId }, select: { returnNumber: true, status: true } });
      if (!r) throw notFoundCtx();
      return { label: `Devolução ao fornecedor #${r.returnNumber}`, details: { returnNumber: r.returnNumber, status: r.status } };
    }
    case 'SUPPORT_TICKET': {
      const where = await visibilityWhere(actor);
      const t = await prisma.supportTicket.findFirst({ where: { AND: [{ id: entityId }, where] }, select: { ticketNumber: true, subject: true } });
      if (!t) throw notFoundCtx();
      return { label: `Chamado anterior #${t.ticketNumber}`, details: { ticketNumber: t.ticketNumber, subject: t.subject } };
    }
    default:
      throw notFoundCtx();
  }
}

// ---------------------------------------------------------------------------------------------------------- views
function ticketView(t: any) {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    module: t.module,
    moduleLabel: SUPPORT_MODULES[t.module as keyof typeof SUPPORT_MODULES] ?? t.module,
    type: t.type,
    typeLabel: SUPPORT_TYPES[t.type as keyof typeof SUPPORT_TYPES] ?? t.type,
    priority: t.priority,
    priorityLabel: SUPPORT_PRIORITIES[t.priority as keyof typeof SUPPORT_PRIORITIES] ?? t.priority,
    status: t.status,
    statusLabel: SUPPORT_STATUSES[t.status as SupportStatus] ?? t.status,
    source: t.source,
    sourceLabel: SUPPORT_SOURCES[t.source as keyof typeof SUPPORT_SOURCES] ?? t.source,
    requester: { id: t.requesterId, name: t.requesterName, role: t.requesterRole },
    company: { id: t.companyId, name: t.companyName },
    branch: t.branchId ? { id: t.branchId, name: t.branchName } : null,
    assignedTo: t.assignedToId ? { id: t.assignedToId, name: t.assignedToName } : null,
    context: t.context ?? null,
    appVersion: t.appVersion,
    lastMessageAt: t.lastMessageAt,
    lastMessageBy: t.lastMessageBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
  };
}

const attachmentView = (a: any) => ({
  id: a.id,
  messageId: a.messageId,
  fileName: a.fileName,
  mimeType: a.mimeType,
  size: a.size,
  uploadedBy: { id: a.uploadedBy, name: a.uploadedByName },
  createdAt: a.createdAt,
  removed: !!a.removedAt,
});

async function addEvent(
  tx: PrismaTransactionClient,
  t: { id: string; companyId: string; branchId: string | null },
  e: { type: string; fromValue?: string | null; toValue?: string | null; actorId: string; actorName: string; actorRole: string }
) {
  await tx.supportTicketEvent.create({ data: { ticketId: t.id, companyId: t.companyId, branchId: t.branchId, ...e } });
}

/** Transição com guarda: só muda se o estado ainda for o lido (corrida → 409). */
async function guardedUpdate(tx: PrismaTransactionClient, t: { id: string; status: string }, data: Prisma.SupportTicketUpdateManyMutationInput) {
  const r = await tx.supportTicket.updateMany({ where: { id: t.id, status: t.status }, data });
  if (r.count === 0) throw new ConflictError('O chamado foi alterado por outra pessoa agora mesmo. Atualize a página e tente de novo.', 'SUPPORT_TICKET_CHANGED');
}

function paging(q: { page?: unknown; limit?: unknown }) {
  const page = Math.max(1, Number.parseInt(String(q.page ?? '1'), 10) || 1);
  const limit = Math.min(SUPPORT_LIMITS.pageMax, Math.max(1, Number.parseInt(String(q.limit ?? '20'), 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function statusFilter(value: unknown): Prisma.SupportTicketWhereInput {
  const v = String(value ?? 'all');
  if (v === 'open') return { status: { in: OPEN_STATUSES } };
  if (v in SUPPORT_STATUSES) return { status: v };
  return {};
}

function searchFilter(q: unknown): Prisma.SupportTicketWhereInput {
  const term = String(q ?? '').trim().replace(/^#/, '');
  if (!term) return {};
  const n = /^\d{1,9}$/.test(term) ? Number(term) : null;
  return { OR: [{ subject: { contains: term, mode: 'insensitive' } }, ...(n !== null ? [{ ticketNumber: n }] : [])] };
}

/** Detalhe comum (empresa e plataforma): mensagens paginadas do fim para o começo, histórico e anexos. */
async function detail(ticket: any, q: { before?: unknown; limit?: unknown }) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(q.limit ?? '50'), 10) || 50));
  const before = q.before ? new Date(String(q.before)) : null;
  const rows = await prisma.supportTicketMessage.findMany({
    where: { ticketId: ticket.id, ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();
  const [events, attachments] = await Promise.all([
    prisma.supportTicketEvent.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: 'asc' }, take: 300 }),
    prisma.supportTicketAttachment.findMany({
      where: { ticketId: ticket.id },
      select: { id: true, messageId: true, fileName: true, mimeType: true, size: true, uploadedBy: true, uploadedByName: true, createdAt: true, removedAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return {
    ticket: { ...ticketView(ticket), description: ticket.description, requesterEmail: ticket.requesterEmail, requesterPhone: ticket.requesterPhone },
    messages: messages.map((m) => ({ id: m.id, author: { id: m.authorId, name: m.authorName, role: m.authorRole }, body: m.body, statusFrom: m.statusFrom, statusTo: m.statusTo, source: m.source, createdAt: m.createdAt })),
    hasMoreMessages: hasMore,
    events: events.map((e) => ({ id: e.id, type: e.type, fromValue: e.fromValue, toValue: e.toValue, actor: { id: e.actorId, name: e.actorName, role: e.actorRole }, createdAt: e.createdAt })),
    attachments: attachments.map(attachmentView),
  };
}

// ---------------------------------------------------------------------------------------------------------- empresa
export class SupportService {
  async create(actor: SupportActor, input: unknown, meta: { source?: string; appVersion?: string | null }) {
    const data = parse(createTicketSchema, input);
    if (!actor.companyId) throw new AppError('Abra a Central de Suporte pelo usuário da empresa.', 403, 'SUPPORT_COMPANY_REQUIRED');
    const source = meta.source && meta.source in SUPPORT_SOURCES && meta.source !== 'SUPER_ADMIN' ? meta.source : 'ADMIN_WEB';
    const appVersion = meta.appVersion ? String(meta.appVersion).replace(/[^\w .\-+]/g, '').slice(0, 40) || null : null;

    let context: Record<string, unknown> | null = null;
    if (data.context) {
      const { entityType, entityId, screen, route, terminal } = data.context;
      const resolved = entityType && entityId ? await resolveContext(actor, entityType as SupportEntityType, entityId) : null;
      context = {
        module: data.module,
        moduleLabel: SUPPORT_MODULES[data.module as keyof typeof SUPPORT_MODULES],
        ...(screen ? { screen } : {}),
        ...(route ? { route } : {}),
        ...(terminal ? { terminal } : {}),
        ...(entityType && resolved
          ? { entityType, entityTypeLabel: SUPPORT_ENTITY_TYPES[entityType as SupportEntityType], entityId, label: resolved.label, details: resolved.details }
          : {}),
      };
    }

    const [me, company, branch] = await Promise.all([
      nameOf(actor.userId),
      prisma.company.findFirst({ where: { id: actor.companyId }, select: { name: true } }),
      actor.branchId ? prisma.branch.findFirst({ where: { id: actor.branchId, companyId: actor.companyId }, select: { name: true } }) : Promise.resolve(null),
    ]);

    const ticket = await runInTransaction(async (tx) => {
      const t = await tx.supportTicket.create({
        data: {
          companyId: actor.companyId!,
          branchId: actor.branchId ?? null,
          requesterId: actor.userId,
          requesterName: me.name,
          requesterEmail: me.email ?? null,
          requesterPhone: me.phone ?? null,
          requesterRole: actor.userType,
          companyName: company?.name ?? null,
          branchName: branch?.name ?? null,
          subject: data.subject,
          module: data.module,
          type: data.type,
          priority: data.priority ?? 'NORMAL',
          description: data.description,
          source,
          appVersion,
          context: context ? (JSON.parse(JSON.stringify(context)) as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      });
      await addEvent(tx, t, { type: 'OPENED', toValue: 'ABERTO', actorId: actor.userId, actorName: me.name, actorRole: 'REQUESTER' });
      return t;
    });
    return ticketView(ticket);
  }

  /** Prévia do contexto para o formulário ("Você está relatando um problema em: …"). */
  async contextPreview(actor: SupportActor, q: { entityType?: unknown; entityId?: unknown }) {
    const entityType = String(q.entityType ?? '');
    const entityId = String(q.entityId ?? '');
    if (!(entityType in SUPPORT_ENTITY_TYPES) || !z.string().uuid().safeParse(entityId).success) throw bad('Referência inválida.', 'VALIDATION_ERROR');
    const r = await resolveContext(actor, entityType as SupportEntityType, entityId);
    return { entityType, entityTypeLabel: SUPPORT_ENTITY_TYPES[entityType as SupportEntityType], entityId, ...r };
  }

  async list(actor: SupportActor, q: Record<string, unknown>) {
    const where: Prisma.SupportTicketWhereInput = { AND: [await visibilityWhere(actor), statusFilter(q.status), searchFilter(q.q)] };
    const { page, limit, skip } = paging(q);
    const [rows, total] = await Promise.all([
      prisma.supportTicket.findMany({ where, orderBy: { lastMessageAt: 'desc' }, skip, take: limit }),
      prisma.supportTicket.count({ where }),
    ]);
    return {
      data: rows.map((t) => ({ ...ticketView(t), unread: t.requesterId === actor.userId && t.lastMessageBy !== 'REQUESTER' && t.lastMessageAt > t.requesterLastReadAt })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      companyWide: await canViewCompanyTickets(actor),
    };
  }

  async unreadCount(actor: SupportActor) {
    if (!actor.companyId) return { unread: 0 };
    const rows = await runInTransaction(
      (tx) => tx.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM support_tickets
        WHERE "companyId" = ${actor.companyId} AND "requesterId" = ${actor.userId}
          AND "lastMessageBy" <> 'REQUESTER' AND "lastMessageAt" > "requesterLastReadAt"`
    );
    return { unread: rows[0]?.n ?? 0 };
  }

  async get(actor: SupportActor, id: string, q: Record<string, unknown>) {
    const t = await loadVisible(actor, id);
    if (t.requesterId === actor.userId) await prisma.supportTicket.update({ where: { id: t.id }, data: { requesterLastReadAt: new Date() } });
    return detail(t, q);
  }

  /** Resposta do solicitante (ou de quem vê a empresa). Reabre o RESOLVIDO; ENCERRADO não aceita resposta. */
  async reply(actor: SupportActor, id: string, input: unknown, meta: { source?: string } = {}) {
    const { body } = parse(messageSchema, input);
    const t = await loadVisible(actor, id);
    if (t.status === 'ENCERRADO') {
      throw new ConflictError(`Este chamado foi encerrado. Abra um novo chamado e cite o #${t.ticketNumber}.`, 'SUPPORT_TICKET_CLOSED');
    }
    const role = t.requesterId === actor.userId ? 'REQUESTER' : 'COMPANY';
    const me = await nameOf(actor.userId);
    const nextStatus: SupportStatus = t.status === 'ABERTO' ? 'ABERTO' : 'AGUARDANDO_SUPORTE';
    const source = meta.source && meta.source in SUPPORT_SOURCES && meta.source !== 'SUPER_ADMIN' ? meta.source : 'ADMIN_WEB';
    const now = new Date();
    const message = await runInTransaction(async (tx) => {
      await guardedUpdate(tx, t, {
        status: nextStatus,
        lastMessageAt: now,
        lastMessageBy: role,
        ...(role === 'REQUESTER' ? { requesterLastReadAt: now } : {}),
        ...(t.status === 'RESOLVIDO' ? { resolvedAt: null } : {}),
      });
      const m = await tx.supportTicketMessage.create({
        data: { ticketId: t.id, companyId: t.companyId, branchId: t.branchId, authorId: actor.userId, authorName: me.name, authorRole: role, body, statusFrom: t.status, statusTo: nextStatus, source },
      });
      if (t.status === 'RESOLVIDO') await addEvent(tx, t, { type: 'REOPENED', fromValue: 'RESOLVIDO', toValue: nextStatus, actorId: actor.userId, actorName: me.name, actorRole: role });
      await addEvent(tx, t, { type: 'REPLIED', fromValue: t.status, toValue: nextStatus, actorId: actor.userId, actorName: me.name, actorRole: role });
      return m;
    });
    return { id: message.id, ticketId: t.id, status: nextStatus, statusFrom: t.status };
  }

  /** O solicitante encerra o próprio chamado (resolvido do lado dele). */
  async close(actor: SupportActor, id: string) {
    const t = await loadVisible(actor, id);
    if (t.requesterId !== actor.userId) throw new AppError('Só quem abriu o chamado pode encerrá-lo por aqui.', 403, 'SUPPORT_NOT_REQUESTER');
    if (t.status === 'ENCERRADO') throw new ConflictError('Este chamado já está encerrado.', 'SUPPORT_TICKET_CLOSED');
    const me = await nameOf(actor.userId);
    await runInTransaction(async (tx) => {
      await guardedUpdate(tx, t, { status: 'ENCERRADO', closedAt: new Date() });
      await addEvent(tx, t, { type: 'CLOSED', fromValue: t.status, toValue: 'ENCERRADO', actorId: actor.userId, actorName: me.name, actorRole: 'REQUESTER' });
    });
    return { id: t.id, status: 'ENCERRADO', statusFrom: t.status };
  }

  /** Reabre um chamado RESOLVIDO (o problema voltou). ENCERRADO é final: abrir outro citando o número. */
  async reopen(actor: SupportActor, id: string) {
    const t = await loadVisible(actor, id);
    if (t.status !== 'RESOLVIDO') {
      throw new ConflictError(
        t.status === 'ENCERRADO' ? `Chamado encerrado não é reaberto. Abra um novo chamado e cite o #${t.ticketNumber}.` : 'Só um chamado resolvido pode ser reaberto.',
        'SUPPORT_TICKET_NOT_REOPENABLE'
      );
    }
    const me = await nameOf(actor.userId);
    const role = t.requesterId === actor.userId ? 'REQUESTER' : 'COMPANY';
    await runInTransaction(async (tx) => {
      await guardedUpdate(tx, t, { status: 'AGUARDANDO_SUPORTE', resolvedAt: null, lastMessageAt: new Date(), lastMessageBy: role });
      await addEvent(tx, t, { type: 'REOPENED', fromValue: 'RESOLVIDO', toValue: 'AGUARDANDO_SUPORTE', actorId: actor.userId, actorName: me.name, actorRole: role });
    });
    return { id: t.id, status: 'AGUARDANDO_SUPORTE', statusFrom: 'RESOLVIDO' };
  }

  // ------------------------------------------------------------------------------------------------------ anexos
  async addAttachment(actor: SupportActor, id: string, input: { fileName?: unknown; mimeType?: unknown; contentBase64?: unknown; messageId?: unknown }, platform = false) {
    const t = platform ? await this.platformLoad(id) : await loadVisible(actor, id);
    if (t.status === 'ENCERRADO') throw new ConflictError(`Este chamado foi encerrado. Abra um novo chamado e cite o #${t.ticketNumber}.`, 'SUPPORT_TICKET_CLOSED');
    const file = validateAttachment(input);
    const count = await prisma.supportTicketAttachment.count({ where: { ticketId: t.id, removedAt: null } });
    if (count >= SUPPORT_LIMITS.attachmentsPerTicket) {
      throw new ConflictError(`Este chamado já tem ${SUPPORT_LIMITS.attachmentsPerTicket} anexos. Remova um ou descreva na mensagem.`, 'ATTACHMENT_LIMIT');
    }
    let messageId: string | null = null;
    if (typeof input.messageId === 'string' && input.messageId) {
      const m = await prisma.supportTicketMessage.findFirst({ where: { id: input.messageId, ticketId: t.id }, select: { id: true } });
      if (!m) throw bad('Mensagem não encontrada neste chamado.', 'SUPPORT_MESSAGE_NOT_FOUND');
      messageId = m.id;
    }
    const me = await nameOf(actor.userId);
    const role = platform ? 'SUPPORT' : t.requesterId === actor.userId ? 'REQUESTER' : 'COMPANY';
    const created = await runInTransaction(async (tx) => {
      const a = await tx.supportTicketAttachment.create({
        data: {
          ticketId: t.id,
          messageId,
          companyId: t.companyId,
          branchId: t.branchId,
          fileName: file.fileName,
          mimeType: file.mimeType,
          size: file.size,
          sha256: file.sha256,
          data: file.data,
          uploadedBy: actor.userId,
          uploadedByName: me.name,
        },
        select: { id: true, messageId: true, fileName: true, mimeType: true, size: true, uploadedBy: true, uploadedByName: true, createdAt: true, removedAt: true },
      });
      await addEvent(tx, t, { type: 'ATTACHMENT_ADDED', toValue: file.fileName, actorId: actor.userId, actorName: me.name, actorRole: role });
      return a;
    });
    return attachmentView(created);
  }

  /** Download: só quem enxerga o chamado; anexo removido não sai. */
  async download(actor: SupportActor, attachmentId: string, platform = false) {
    const a = await prisma.supportTicketAttachment.findFirst({ where: { id: attachmentId, removedAt: null } });
    if (!a) throw new AppError('Anexo não encontrado.', 404, 'ATTACHMENT_NOT_FOUND');
    if (platform) await this.platformLoad(a.ticketId);
    else await loadVisible(actor, a.ticketId).catch(() => {
      throw new AppError('Anexo não encontrado.', 404, 'ATTACHMENT_NOT_FOUND');
    });
    return { fileName: a.fileName, mimeType: a.mimeType, size: a.size, data: Buffer.from(a.data) };
  }

  /** Remoção lógica: quem enviou (ou o suporte). O arquivo deixa de ser baixável; o histórico registra a remoção. */
  async removeAttachment(actor: SupportActor, attachmentId: string, platform = false) {
    const a = await prisma.supportTicketAttachment.findFirst({ where: { id: attachmentId, removedAt: null }, select: { id: true, ticketId: true, fileName: true, uploadedBy: true } });
    if (!a) throw new AppError('Anexo não encontrado.', 404, 'ATTACHMENT_NOT_FOUND');
    const t = platform ? await this.platformLoad(a.ticketId) : await loadVisible(actor, a.ticketId);
    if (!platform && a.uploadedBy !== actor.userId) throw new AppError('Só quem enviou o anexo pode removê-lo.', 403, 'ATTACHMENT_NOT_OWNER');
    const me = await nameOf(actor.userId);
    await runInTransaction(async (tx) => {
      const r = await tx.supportTicketAttachment.updateMany({ where: { id: a.id, removedAt: null }, data: { removedAt: new Date(), removedBy: actor.userId } });
      if (r.count === 0) throw new AppError('Anexo não encontrado.', 404, 'ATTACHMENT_NOT_FOUND');
      await addEvent(tx, t, { type: 'ATTACHMENT_REMOVED', fromValue: a.fileName, actorId: actor.userId, actorName: me.name, actorRole: platform ? 'SUPPORT' : 'REQUESTER' });
    });
    return { id: a.id, removed: true };
  }

  // ------------------------------------------------------------------------------------------------------ plataforma
  /** Contexto de plataforma (SUPER_ADMIN, via tenantIsolation da rota): enxerga todas as empresas — por isso só nas rotas do console. */
  private async platformLoad(id: string) {
    const t = await prisma.supportTicket.findFirst({ where: { id } });
    if (!t) throw notFound();
    return t;
  }

  async platformDashboard() {
    const grouped = await prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } });
    const by = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const unassigned = await prisma.supportTicket.count({ where: { status: { in: OPEN_STATUSES }, assignedToId: null } });
    const waitingSupport = await prisma.supportTicket.count({ where: { status: { in: ['ABERTO', 'AGUARDANDO_SUPORTE'] } } });
    return {
      byStatus: Object.keys(SUPPORT_STATUSES).map((s) => ({ status: s, label: SUPPORT_STATUSES[s as SupportStatus], count: by[s] ?? 0 })),
      open: OPEN_STATUSES.reduce((sum, s) => sum + (by[s] ?? 0), 0),
      unassigned,
      waitingSupport,
    };
  }

  async platformList(q: Record<string, unknown>) {
    const and: Prisma.SupportTicketWhereInput[] = [statusFilter(q.status), searchFilter(q.q)];
    if (q.companyId) and.push({ companyId: String(q.companyId) });
    if (q.branchId) and.push({ branchId: String(q.branchId) });
    if (q.module && String(q.module) in SUPPORT_MODULES) and.push({ module: String(q.module) });
    if (q.type && String(q.type) in SUPPORT_TYPES) and.push({ type: String(q.type) });
    if (q.priority && String(q.priority) in SUPPORT_PRIORITIES) and.push({ priority: String(q.priority) });
    if (q.assignedToId === 'unassigned') and.push({ assignedToId: null });
    else if (q.assignedToId) and.push({ assignedToId: String(q.assignedToId) });
    const from = q.from ? new Date(String(q.from)) : null;
    const to = q.to ? new Date(String(q.to)) : null;
    if (from && !Number.isNaN(from.getTime())) and.push({ createdAt: { gte: from } });
    if (to && !Number.isNaN(to.getTime())) and.push({ createdAt: { lte: to } });
    const where = { AND: and };
    const { page, limit, skip } = paging(q);
    const [rows, total] = await Promise.all([
      prisma.supportTicket.findMany({ where, orderBy: [{ lastMessageAt: 'desc' }], skip, take: limit }),
      prisma.supportTicket.count({ where }),
    ]);
    return {
      data: rows.map((t) => ({ ...ticketView(t), unreadForSupport: t.lastMessageBy !== 'SUPPORT' && (!t.supportLastReadAt || t.lastMessageAt > t.supportLastReadAt) })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async platformGet(_actor: SupportActor, id: string, q: Record<string, unknown>) {
    const t = await this.platformLoad(id);
    await prisma.supportTicket.update({ where: { id: t.id }, data: { supportLastReadAt: new Date() } });
    return detail(t, q);
  }

  async platformReply(actor: SupportActor, id: string, input: unknown) {
    const { body } = parse(messageSchema, input);
    const statusRaw = (input as any)?.status;
    const nextStatus: SupportStatus = statusRaw && SUPPORT_SETTABLE_STATUSES.includes(statusRaw) ? statusRaw : 'AGUARDANDO_USUARIO';
    const t = await this.platformLoad(id);
    if (t.status === 'ENCERRADO') throw new ConflictError('Chamado encerrado não recebe resposta. Peça ao cliente que abra um novo citando este número.', 'SUPPORT_TICKET_CLOSED');
    const me = await nameOf(actor.userId);
    const now = new Date();
    const autoAssign = !t.assignedToId;
    await runInTransaction(async (tx) => {
      await guardedUpdate(tx, t, {
        status: nextStatus,
        lastMessageAt: now,
        lastMessageBy: 'SUPPORT',
        supportLastReadAt: now,
        ...(t.firstResponseAt ? {} : { firstResponseAt: now }),
        ...(autoAssign ? { assignedToId: actor.userId, assignedToName: me.name, assignedAt: now } : {}),
        ...(nextStatus === 'RESOLVIDO' ? { resolvedAt: now } : {}),
        ...(nextStatus === 'ENCERRADO' ? { closedAt: now } : {}),
      });
      await tx.supportTicketMessage.create({
        data: { ticketId: t.id, companyId: t.companyId, branchId: t.branchId, authorId: actor.userId, authorName: me.name, authorRole: 'SUPPORT', body, statusFrom: t.status, statusTo: nextStatus, source: 'SUPER_ADMIN' },
      });
      if (autoAssign) await addEvent(tx, t, { type: 'ASSIGNED', toValue: me.name, actorId: actor.userId, actorName: me.name, actorRole: 'SUPPORT' });
      await addEvent(tx, t, { type: 'REPLIED', fromValue: t.status, toValue: nextStatus, actorId: actor.userId, actorName: me.name, actorRole: 'SUPPORT' });
    });
    return { id: t.id, status: nextStatus, statusFrom: t.status };
  }

  async platformAssign(actor: SupportActor, id: string, input: { assigneeId?: unknown }) {
    const t = await this.platformLoad(id);
    const assigneeId = input.assigneeId === null || input.assigneeId === '' ? null : String(input.assigneeId ?? '');
    let assignee: { id: string; name: string } | null = null;
    if (assigneeId) {
      const u = await prisma.user.findFirst({ where: { id: assigneeId, userType: 'SUPER_ADMIN', isActive: true }, select: { id: true, name: true } });
      if (!u) throw bad('Responsável inválido: escolha alguém da equipe de suporte.', 'SUPPORT_INVALID_ASSIGNEE');
      assignee = u;
    }
    const me = await nameOf(actor.userId);
    const next: SupportStatus = assignee && t.status === 'ABERTO' ? 'EM_ANALISE' : (t.status as SupportStatus);
    await runInTransaction(async (tx) => {
      await guardedUpdate(tx, t, { assignedToId: assignee?.id ?? null, assignedToName: assignee?.name ?? null, assignedAt: assignee ? new Date() : null, status: next });
      await addEvent(tx, t, { type: assignee ? 'ASSIGNED' : 'UNASSIGNED', fromValue: t.assignedToName, toValue: assignee?.name ?? null, actorId: actor.userId, actorName: me.name, actorRole: 'SUPPORT' });
      if (next !== t.status) await addEvent(tx, t, { type: 'STATUS_CHANGED', fromValue: t.status, toValue: next, actorId: actor.userId, actorName: me.name, actorRole: 'SUPPORT' });
    });
    return { id: t.id, assignedTo: assignee, status: next, statusFrom: t.status, assignedFrom: t.assignedToName };
  }

  async platformSetStatus(actor: SupportActor, id: string, input: { status?: unknown }) {
    const status = String(input.status ?? '');
    if (!SUPPORT_SETTABLE_STATUSES.includes(status as SupportStatus)) throw bad('Estado inválido para o chamado.', 'SUPPORT_INVALID_STATUS');
    const t = await this.platformLoad(id);
    if (t.status === status) return { id: t.id, status, statusFrom: t.status };
    if (t.status === 'ENCERRADO') throw new ConflictError('Chamado encerrado é final.', 'SUPPORT_TICKET_CLOSED');
    const me = await nameOf(actor.userId);
    const now = new Date();
    await runInTransaction(async (tx) => {
      await guardedUpdate(tx, t, {
        status,
        ...(status === 'RESOLVIDO' ? { resolvedAt: now } : {}),
        ...(status === 'ENCERRADO' ? { closedAt: now } : {}),
        ...(t.status === 'RESOLVIDO' && status !== 'ENCERRADO' ? { resolvedAt: null } : {}),
      });
      await addEvent(tx, t, { type: 'STATUS_CHANGED', fromValue: t.status, toValue: status, actorId: actor.userId, actorName: me.name, actorRole: 'SUPPORT' });
    });
    return { id: t.id, status, statusFrom: t.status };
  }

  async platformSetPriority(actor: SupportActor, id: string, input: { priority?: unknown }) {
    const priority = String(input.priority ?? '');
    if (!(priority in SUPPORT_PRIORITIES)) throw bad('Prioridade inválida.', 'SUPPORT_INVALID_PRIORITY');
    const t = await this.platformLoad(id);
    if (t.priority === priority) return { id: t.id, priority, priorityFrom: t.priority };
    const me = await nameOf(actor.userId);
    await runInTransaction(async (tx) => {
      const r = await tx.supportTicket.updateMany({ where: { id: t.id, priority: t.priority }, data: { priority } });
      if (r.count === 0) throw new ConflictError('O chamado foi alterado por outra pessoa agora mesmo. Atualize a página e tente de novo.', 'SUPPORT_TICKET_CHANGED');
      await addEvent(tx, t, { type: 'PRIORITY_CHANGED', fromValue: t.priority, toValue: priority, actorId: actor.userId, actorName: me.name, actorRole: 'SUPPORT' });
    });
    return { id: t.id, priority, priorityFrom: t.priority };
  }

  /** Equipe de suporte = usuários da plataforma ativos, com a carga de chamados em aberto de cada um. */
  async platformAgents() {
    const agents = await prisma.user.findMany({ where: { userType: 'SUPER_ADMIN', isActive: true }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } });
    const load = await prisma.supportTicket.groupBy({ by: ['assignedToId'], where: { status: { in: OPEN_STATUSES }, assignedToId: { not: null } }, _count: { _all: true } });
    const byId = new Map(load.map((l) => [l.assignedToId, l._count._all]));
    return agents.map((a) => ({ ...a, openTickets: byId.get(a.id) ?? 0 }));
  }

  async platformCompanies() {
    const rows = await prisma.supportTicket.groupBy({ by: ['companyId', 'companyName'], _count: { _all: true } });
    return rows.map((r) => ({ id: r.companyId, name: r.companyName, tickets: r._count._all })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
}

export const supportService = new SupportService();
