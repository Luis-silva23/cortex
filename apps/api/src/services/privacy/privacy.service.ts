import { createHash } from 'crypto';
import { prisma, runInTransaction, runWithRLSContext } from '@ln-system/database';
import type { RawTransactionClient } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { openSecret, sealSecret } from '@ln-system/shared/utils/secret-box';
import { logger } from '../../utils/logger';

/**
 * PEDIDOS DE TITULAR (LGPD) — exportação e anonimização de UM cliente (decisão 120, 2026-10-14).
 *
 * Quem pode: só o COMPANY_ADMIN da empresa dona do cadastro (a plataforma não opera dado de cliente final de uma loja). O titular é
 * sempre procurado POR EMPRESA (`id` + `companyId`): trocar o id na URL por um cliente de outra empresa dá "não encontrado".
 *
 * EXPORTAÇÃO: monta um JSON estruturado e versionado (`cortex.data-subject-export.v1`) só com dados do titular (minimização: nada de
 * dado de outras pessoas, de outros clientes nem de pagamento), guarda-o CIFRADO (enc:v1) na própria linha do pedido, por 24 h e no
 * máximo 3 downloads; depois disso o conteúdo é apagado (rotina diária + na própria tentativa). Não existe arquivo temporário em disco.
 *
 * ANONIMIZAÇÃO (irreversível; nada é "escondido na tela"): o cadastro do cliente e os textos livres ligados a ele são SOBRESCRITOS no
 * banco, numa única transação (tudo ou nada). Valores, datas, números, estoque e vínculos (id do cliente) são preservados — a
 * integridade financeira, fiscal e de auditoria não é tocada, e nenhuma linha financeira é apagada. RETENÇÃO (art. 16 da LGPD):
 *   - documento fiscal autorizado nos últimos N anos (PRIVACY_FISCAL_RETENTION_YEARS, padrão 5, a confirmar com o contador): nome e
 *     CPF/CNPJ ficam até o fim do prazo (o contato é apagado) → status PARTIAL com `retainedUntil`;
 *   - garantia vigente: placa, chassi e motor do veículo ficam até o fim da garantia → PARTIAL;
 *   - cobrança em aberto (a receber pendente/vencido), venda não quitada ou OS em andamento: exercício regular de direitos e execução
 *     do contrato → BLOQUEADO (nada muda) até a situação se resolver.
 * Fora do alcance (e dito no resultado): trilha de auditoria (append-only), pedidos de canais externos (o payload do pedido não tem
 * vínculo com o cadastro) e backups (seguem o ciclo de retenção deles).
 * O registro do pedido guarda só contagens, motivos e datas — nunca o dado pessoal original.
 */
export const PRIVACY_LIMITS = { exportTtlHours: 24, maxDownloads: 3, maxRequestsPerHour: 20, rowCap: 2000, justificationMin: 10, justificationMax: 500 };
const EXPORT_SCHEMA = 'cortex.data-subject-export.v1';

export interface PrivacyActor {
  userId: string;
  companyId: string;
}

const fiscalRetentionYears = () => {
  const n = Number.parseInt(process.env.PRIVACY_FISCAL_RETENTION_YEARS ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : 5;
};

const addYears = (d: Date, years: number) => {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
};

export function assertJustification(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length < PRIVACY_LIMITS.justificationMin || text.length > PRIVACY_LIMITS.justificationMax) {
    throw new AppError(`Informe a justificativa do pedido (${PRIVACY_LIMITS.justificationMin} a ${PRIVACY_LIMITS.justificationMax} caracteres).`, 400, 'JUSTIFICATION_REQUIRED');
  }
  return text;
}

async function findSubject(db: Pick<typeof prisma, 'customer'> | RawTransactionClient, companyId: string, customerId: unknown) {
  if (typeof customerId !== 'string' || !customerId) throw new AppError('Informe o cliente (titular).', 400, 'SUBJECT_REQUIRED');
  const customer = await (db as any).customer.findFirst({ where: { id: customerId, companyId } });
  if (!customer) throw new AppError('Titular não encontrado nesta empresa.', 404, 'SUBJECT_NOT_FOUND');
  return customer as Record<string, any>;
}

async function throttle(actor: PrivacyActor) {
  const since = new Date(Date.now() - 3600_000);
  const recent = await prisma.privacyRequest.count({ where: { companyId: actor.companyId, requestedBy: actor.userId, requestedAt: { gte: since } } });
  if (recent >= PRIVACY_LIMITS.maxRequestsPerHour) {
    throw new AppError('Limite de pedidos de titular por hora atingido. Tente novamente mais tarde.', 429, 'PRIVACY_RATE_LIMIT');
  }
}

const summary = (r: any) => ({
  id: r.id,
  requestType: r.requestType,
  subjectType: r.subjectType,
  subjectId: r.subjectId,
  status: r.status,
  justification: r.justification,
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt,
  executedBy: r.executedBy,
  executedAt: r.executedAt,
  plan: r.plan,
  result: r.result,
  retainedUntil: r.retainedUntil,
  exportAvailable: !!r.exportPayload && !r.exportPurgedAt && !!r.exportExpiresAt && r.exportExpiresAt > new Date() && r.exportDownloads < PRIVACY_LIMITS.maxDownloads,
  exportExpiresAt: r.exportExpiresAt,
  exportDownloads: r.exportDownloads,
});

// ---------------------------------------------------------------------------------------------------------------------------
// EXPORTAÇÃO
// ---------------------------------------------------------------------------------------------------------------------------
async function capped<T>(rows: Promise<T[]>): Promise<{ items: T[]; truncated: boolean }> {
  const all = await rows;
  return { items: all.slice(0, PRIVACY_LIMITS.rowCap), truncated: all.length > PRIVACY_LIMITS.rowCap };
}

export async function buildExport(companyId: string, customer: Record<string, any>, requestId: string, company: { id: string; name: string }) {
  const where = { companyId, customerId: customer.id as string };
  const take = PRIVACY_LIMITS.rowCap + 1;
  const [vehicles, quotes, sales, orders, revisions, followUps, appointments, warranties, receivables, attempts, audit] = await Promise.all([
    capped(prisma.motorcycle.findMany({ where, take, orderBy: { createdAt: 'asc' }, select: { id: true, licensePlate: true, chassisNumber: true, engineNumber: true, brand: true, model: true, year: true, color: true, vehicleType: true, kilometerReading: true, isActive: true, createdAt: true } })),
    capped(prisma.quote.findMany({ where, take, orderBy: { createdAt: 'asc' }, select: { id: true, quoteNumber: true, status: true, validUntil: true, notes: true, closedAt: true, createdAt: true } })),
    capped(prisma.sale.findMany({ where, take, orderBy: { saleDate: 'asc' }, select: { id: true, saleNumber: true, status: true, saleDate: true, subtotal: true, discountAmount: true, totalAmount: true, paidAmount: true, notes: true, _count: { select: { items: true, payments: true } } } })),
    capped(prisma.serviceOrder.findMany({ where, take, orderBy: { entryDate: 'asc' }, select: { id: true, osNumber: true, status: true, entryDate: true, deliveryDate: true, entryNotes: true, diagnosticNotes: true, finalTotal: true, isPaid: true, paidAt: true } })),
    capped(prisma.revision.findMany({ where, take, orderBy: { performedAt: 'asc' }, select: { id: true, performedAt: true, kilometerAtService: true, servicesPerformed: true, partsReplaced: true, recommendations: true, notes: true, nextDueDate: true } })),
    capped(prisma.followUp.findMany({ where, take, orderBy: { dueDate: 'asc' }, select: { id: true, dueDate: true, status: true, notes: true } })),
    capped(prisma.appointment.findMany({ where, take, orderBy: { scheduledAt: 'asc' }, select: { id: true, scheduledAt: true, status: true, customerConfirmed: true, confirmedAt: true, notes: true } })),
    capped(prisma.serviceOrderWarranty.findMany({ where, take, orderBy: { startDate: 'asc' }, select: { id: true, coverage: true, startDate: true, validUntil: true, conditions: true, notes: true } })),
    capped(prisma.accountsReceivable.findMany({ where, take, orderBy: { dueDate: 'asc' }, select: { id: true, description: true, amount: true, dueDate: true, paidDate: true, status: true, notes: true } })),
    capped(
      prisma.collectionAttempt.findMany({
        where: { companyId, receivable: { customerId: customer.id as string } },
        take,
        orderBy: { createdAt: 'asc' },
        select: { id: true, channel: true, recipient: true, amount: true, dueDate: true, status: true, createdAt: true },
      })
    ),
    // Trilha do cadastro: o QUE aconteceu e QUANDO (os valores antigos/novos não saem: podem trazer dado de outras pessoas e já constam acima).
    capped(prisma.auditLog.findMany({ where: { companyId, entity: 'Customer', entityId: customer.id as string }, take, orderBy: { createdAt: 'asc' }, select: { action: true, createdAt: true } })),
  ]);
  const sections = { vehicles, quotes, sales, orders, revisions, followUps, appointments, warranties, receivables, attempts, audit };
  const counts = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.items.length]));
  const truncated = Object.entries(sections).filter(([, v]) => v.truncated).map(([k]) => k);
  const { companyId: _c, ...customerData } = customer;
  const document = {
    schema: EXPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    requestId,
    company: { id: company.id, name: company.name },
    subject: { type: 'CUSTOMER', id: customer.id },
    notice:
      'Dados pessoais do titular mantidos por esta empresa no CÓRTEX. Não inclui dados de pagamento (cartão), dados de outras pessoas, trilha técnica de segurança nem backups. Textos livres aparecem como foram registrados.',
    truncatedSections: truncated,
    customer: customerData,
    vehicles: vehicles.items,
    quotes: quotes.items,
    sales: sales.items.map(({ _count, ...s }) => ({ ...s, itemsCount: _count.items, paymentsCount: _count.payments })),
    serviceOrders: orders.items,
    revisions: revisions.items,
    followUps: followUps.items,
    appointments: appointments.items,
    warranties: warranties.items,
    receivables: receivables.items,
    collectionAttempts: attempts.items,
    customerAuditTrail: audit.items,
  };
  return { document, counts, truncated };
}

export async function requestExport(actor: PrivacyActor, customerId: unknown, justificationRaw: unknown) {
  const justification = assertJustification(justificationRaw);
  const customer = await findSubject(prisma, actor.companyId, customerId);
  await throttle(actor);
  const company = await prisma.company.findFirst({ where: { id: actor.companyId }, select: { id: true, name: true } });
  if (!company) throw new AppError('Empresa não encontrada.', 404, 'COMPANY_NOT_FOUND');
  const requestId = (await prisma.privacyRequest.create({
    data: { companyId: actor.companyId, requestType: 'EXPORT', subjectId: customer.id, status: 'FAILED', justification, requestedBy: actor.userId, failureCode: 'EXPORT_NOT_FINISHED' },
    select: { id: true },
  })).id;
  try {
    const { document, counts, truncated } = await buildExport(actor.companyId, customer, requestId, company);
    const json = JSON.stringify(document);
    const now = new Date();
    const updated = await prisma.privacyRequest.update({
      where: { id: requestId },
      data: {
        status: 'COMPLETED',
        failureCode: null,
        executedBy: actor.userId,
        executedAt: now,
        result: { counts, truncatedSections: truncated, bytes: Buffer.byteLength(json) },
        exportPayload: sealSecret(json),
        exportSha256: createHash('sha256').update(json).digest('hex'),
        exportExpiresAt: new Date(now.getTime() + PRIVACY_LIMITS.exportTtlHours * 3600_000),
      },
    });
    return summary(updated);
  } catch (error) {
    await prisma.privacyRequest.update({ where: { id: requestId }, data: { status: 'FAILED', failureCode: 'EXPORT_FAILED' } }).catch(() => undefined);
    logger.error('Falha ao gerar exportação de titular', { requestId, error: (error as Error).name });
    throw new AppError('Não foi possível gerar a exportação. Tente novamente.', 500, 'EXPORT_FAILED');
  }
}

/** Entrega o arquivo (uma vez por chamada, no máximo 3 chamadas e só dentro da validade). Depois, o conteúdo é apagado. */
export async function downloadExport(actor: PrivacyActor, requestId: string) {
  const request = await prisma.privacyRequest.findFirst({ where: { id: requestId, companyId: actor.companyId, requestType: 'EXPORT' } });
  if (!request) throw new AppError('Pedido não encontrado.', 404, 'REQUEST_NOT_FOUND');
  const gone = () => new AppError('Esta exportação expirou ou já foi baixada o máximo de vezes. Faça um novo pedido.', 410, 'EXPORT_EXPIRED');
  if (request.status !== 'COMPLETED' || !request.exportPayload || request.exportPurgedAt) throw gone();
  const now = new Date();
  if (!request.exportExpiresAt || request.exportExpiresAt <= now) {
    await prisma.privacyRequest.updateMany({ where: { id: request.id, companyId: actor.companyId }, data: { exportPayload: null, exportPurgedAt: now } });
    throw gone();
  }
  // Contagem atômica: duas requisições simultâneas não passam do limite.
  const taken = await prisma.privacyRequest.updateMany({
    where: { id: request.id, companyId: actor.companyId, exportDownloads: { lt: PRIVACY_LIMITS.maxDownloads }, exportPurgedAt: null },
    data: { exportDownloads: { increment: 1 } },
  });
  if (taken.count === 0) throw gone();
  const content = openSecret(request.exportPayload);
  if (request.exportDownloads + 1 >= PRIVACY_LIMITS.maxDownloads) {
    await prisma.privacyRequest.updateMany({ where: { id: request.id, companyId: actor.companyId }, data: { exportPayload: null, exportPurgedAt: new Date() } });
  }
  return { content, sha256: request.exportSha256 as string, fileName: `titular-${request.subjectId.slice(0, 8)}-${now.toISOString().slice(0, 10)}.json` };
}

/** Rotina diária: apaga o conteúdo de exportações vencidas (de todas as empresas). Devolve quantas foram apagadas. */
export async function purgeExpiredExports(now = new Date()): Promise<number> {
  return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    const result = await prisma.privacyRequest.updateMany({
      where: { exportPayload: { not: null }, exportExpiresAt: { lt: now } },
      data: { exportPayload: null, exportPurgedAt: now },
    });
    return result.count;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// ANONIMIZAÇÃO
// ---------------------------------------------------------------------------------------------------------------------------
export interface AnonymizationPlan {
  evaluatedAt: string;
  blocked: { code: string; count: number }[];
  retain: { category: string; reason: string; until: string; fields: string[] }[];
  willAnonymize: Record<string, number | string | string[]>;
  fiscalSaleIds: string[];
  fiscalOrderIds: string[];
  keepVehicleIdentifiers: boolean;
  keepIdentification: boolean;
}

const CUSTOMER_CONTACT_FIELDS = ['email', 'phone', 'mobile', 'whatsapp', 'birthDate', 'address', 'city', 'state', 'zipCode', 'notes', 'preferredContact'];
const ANONYMIZED_NAME = (id: string) => `Titular anonimizado ${id.slice(0, 8)}`;

export async function computePlan(db: any, companyId: string, customer: Record<string, any>, now = new Date()): Promise<AnonymizationPlan> {
  const where = { companyId, customerId: customer.id as string };
  const [sales, orders, warranties, openReceivables, motorcycles] = await Promise.all([
    db.sale.findMany({ where, select: { id: true, status: true } }),
    db.serviceOrder.findMany({ where, select: { id: true, status: true } }),
    db.serviceOrderWarranty.findMany({ where: { ...where, validUntil: { gt: now } }, select: { validUntil: true } }),
    db.accountsReceivable.count({ where: { ...where, status: { in: ['PENDING', 'OVERDUE'] } } }),
    db.motorcycle.count({ where }),
  ]);
  const saleIds = sales.map((s: any) => s.id);
  const orderIds = orders.map((o: any) => o.id);
  const docs: any[] =
    saleIds.length || orderIds.length
      ? await db.fiscalDocument.findMany({
          where: { companyId, OR: [...(saleIds.length ? [{ saleId: { in: saleIds } }] : []), ...(orderIds.length ? [{ serviceOrderId: { in: orderIds } }] : [])] },
          select: { saleId: true, serviceOrderId: true, status: true, authorizedAt: true, issuedAt: true, createdAt: true },
        })
      : [];
  const fiscalDocs = docs.filter((d) => d.authorizedAt || d.status === 'AUTHORIZED' || d.status === 'CONTINGENCY');
  const fiscalDates = fiscalDocs.map((d) => new Date(d.authorizedAt ?? d.issuedAt ?? d.createdAt));
  const fiscalUntil = fiscalDates.length ? addYears(new Date(Math.max(...fiscalDates.map((d) => d.getTime()))), fiscalRetentionYears()) : null;
  const fiscalActive = !!fiscalUntil && fiscalUntil > now;
  const warrantyUntil = warranties.length ? new Date(Math.max(...warranties.map((w: any) => new Date(w.validUntil).getTime()))) : null;
  const blocked: { code: string; count: number }[] = [];
  if (openReceivables > 0) blocked.push({ code: 'OPEN_RECEIVABLES', count: openReceivables });
  const openSales = sales.filter((s: any) => s.status === 'PENDING' || s.status === 'PARTIALLY_PAID').length;
  if (openSales > 0) blocked.push({ code: 'OPEN_SALES', count: openSales });
  const openOrders = orders.filter((o: any) => o.status !== 'ENCERRADA' && o.status !== 'CANCELADA').length;
  if (openOrders > 0) blocked.push({ code: 'OPEN_SERVICE_ORDERS', count: openOrders });
  const retain: AnonymizationPlan['retain'] = [];
  if (fiscalActive) retain.push({ category: 'CUSTOMER_IDENTIFICATION', reason: 'FISCAL_DOCUMENT_RETENTION', until: fiscalUntil!.toISOString(), fields: ['name', 'document'] });
  if (warrantyUntil) retain.push({ category: 'VEHICLE_IDENTIFIERS', reason: 'ACTIVE_WARRANTY', until: warrantyUntil.toISOString(), fields: ['licensePlate', 'chassisNumber', 'engineNumber'] });
  const fiscalSaleIds = fiscalActive ? [...new Set(fiscalDocs.map((d) => d.saleId).filter(Boolean))] as string[] : [];
  const fiscalOrderIds = fiscalActive ? [...new Set(fiscalDocs.map((d) => d.serviceOrderId).filter(Boolean))] as string[] : [];
  const alreadyDone = !!customer.anonymizedAt && customer.document === null && String(customer.name).startsWith('Titular anonimizado');
  return {
    evaluatedAt: now.toISOString(),
    blocked: alreadyDone ? [{ code: 'ALREADY_ANONYMIZED', count: 1 }] : blocked,
    retain,
    willAnonymize: {
      customerFields: [...CUSTOMER_CONTACT_FIELDS, ...(fiscalActive ? [] : ['name', 'document'])],
      motorcycles: warrantyUntil ? 0 : motorcycles,
      textRecords: 'quotes, serviceOrders (entryNotes, personalItems), revisions, followUps, appointments, warranties, receivables (notes), sales without fiscal retention (notes)',
    },
    fiscalSaleIds,
    fiscalOrderIds,
    keepVehicleIdentifiers: !!warrantyUntil,
    keepIdentification: fiscalActive,
  };
}

const publicPlan = ({ fiscalSaleIds, fiscalOrderIds, ...plan }: AnonymizationPlan) => ({ ...plan, retainedSales: fiscalSaleIds.length, retainedServiceOrders: fiscalOrderIds.length });

export async function requestAnonymization(actor: PrivacyActor, customerId: unknown, justificationRaw: unknown) {
  const justification = assertJustification(justificationRaw);
  const customer = await findSubject(prisma, actor.companyId, customerId);
  await throttle(actor);
  const plan = await computePlan(prisma, actor.companyId, customer);
  const created = await prisma.privacyRequest.create({
    data: {
      companyId: actor.companyId,
      requestType: 'ANONYMIZE',
      subjectId: customer.id,
      status: 'PLANNED',
      justification,
      requestedBy: actor.userId,
      plan: publicPlan(plan) as any,
    },
  });
  return summary(created);
}

class AnonymizationBlocked extends Error {
  constructor(readonly blocked: { code: string; count: number }[]) {
    super('ANONYMIZATION_BLOCKED');
  }
}

export async function executeAnonymization(actor: PrivacyActor, requestId: string) {
  const request = await prisma.privacyRequest.findFirst({ where: { id: requestId, companyId: actor.companyId, requestType: 'ANONYMIZE' } });
  if (!request) throw new AppError('Pedido não encontrado.', 404, 'REQUEST_NOT_FOUND');
  if (request.status !== 'PLANNED') throw new AppError('Este pedido já foi executado. Faça um novo pedido se for preciso.', 409, 'REQUEST_ALREADY_EXECUTED');
  const customer = await findSubject(prisma, actor.companyId, request.subjectId);
  const now = new Date();

  try {
    const outcome = await runInTransaction(async (tx) => {
      // O plano é RECALCULADO aqui dentro (o estado pode ter mudado desde o planejamento): vale o de agora.
      const fresh = await computePlan(tx, actor.companyId, customer, now);
      if (fresh.blocked.length) throw new AnonymizationBlocked(fresh.blocked);
      const whereC = { companyId: actor.companyId, customerId: customer.id as string };
      const counts: Record<string, number> = {};
      await tx.customer.updateMany({
        where: { id: customer.id, companyId: actor.companyId },
        data: {
          email: null, phone: null, mobile: null, whatsapp: null, birthDate: null, address: null, city: null, state: null, zipCode: null, notes: null, preferredContact: null,
          isActive: false,
          anonymizedAt: now,
          ...(fresh.keepIdentification ? {} : { name: ANONYMIZED_NAME(customer.id), document: null }),
        },
      });
      counts.customer = 1;
      if (!fresh.keepVehicleIdentifiers) {
        counts.motorcycles = (await tx.motorcycle.updateMany({ where: whereC, data: { licensePlate: null, chassisNumber: null, engineNumber: null } })).count;
      }
      counts.quotes = (await tx.quote.updateMany({ where: whereC, data: { notes: null } })).count;
      counts.serviceOrders = (await tx.serviceOrder.updateMany({ where: whereC, data: { entryNotes: null, personalItems: null } })).count;
      counts.revisions = (await tx.revision.updateMany({ where: whereC, data: { notes: null } })).count;
      counts.followUps = (await tx.followUp.updateMany({ where: whereC, data: { notes: null } })).count;
      counts.appointments = (await tx.appointment.updateMany({ where: whereC, data: { notes: null, confirmedByName: null } })).count;
      counts.warranties = (await tx.serviceOrderWarranty.updateMany({ where: whereC, data: { notes: null } })).count;
      counts.receivables = (await tx.accountsReceivable.updateMany({ where: whereC, data: { notes: null } })).count;
      counts.sales = (await tx.sale.updateMany({ where: { ...whereC, ...(fresh.fiscalSaleIds.length ? { id: { notIn: fresh.fiscalSaleIds } } : {}) }, data: { notes: null } })).count;
      const retained: { category: string; reason: string; until?: string; count?: number }[] = fresh.retain.map((r) => ({ category: r.category, reason: r.reason, until: r.until }));
      retained.push({ category: 'AUDIT_TRAIL', reason: 'SECURITY_ACCOUNTABILITY_APPEND_ONLY' });
      if (fresh.fiscalSaleIds.length) retained.push({ category: 'SALE_NOTES', reason: 'FISCAL_DOCUMENT_RETENTION' });
      // Tentativas de cobrança são EVIDÊNCIA append-only (sem UPDATE para ninguém; só expurgo de Super Admin por rotina de retenção): o
      // destinatário (telefone/e-mail) não é reescrito aqui. Fica dito no resultado, e o pedido sai como PARCIAL.
      const attempts = await tx.collectionAttempt.count({ where: { companyId: actor.companyId, receivable: { customerId: customer.id } } });
      if (attempts > 0) retained.push({ category: 'COLLECTION_ATTEMPT_RECIPIENT', reason: 'APPEND_ONLY_EVIDENCE', count: attempts });
      const untilDates = fresh.retain.map((r) => new Date(r.until).getTime());
      return { counts, retained, retainedUntil: untilDates.length ? new Date(Math.max(...untilDates)) : null, partial: fresh.retain.length > 0 || attempts > 0 };
    });
    const updated = await prisma.privacyRequest.update({
      where: { id: request.id },
      data: {
        status: outcome.partial ? 'PARTIAL' : 'COMPLETED',
        executedBy: actor.userId,
        executedAt: now,
        retainedUntil: outcome.retainedUntil,
        result: { counts: outcome.counts, retained: outcome.retained, outOfScope: ['AUDIT_TRAIL', 'EXTERNAL_ORDER_PAYLOADS', 'BACKUPS'] } as any,
      },
    });
    return summary(updated);
  } catch (error) {
    if (error instanceof AnonymizationBlocked) {
      const updated = await prisma.privacyRequest.update({
        where: { id: request.id },
        data: { status: 'BLOCKED', executedBy: actor.userId, executedAt: now, result: { blocked: error.blocked } as any },
      });
      return summary(updated);
    }
    await prisma.privacyRequest.update({ where: { id: request.id }, data: { status: 'FAILED', failureCode: 'EXECUTION_FAILED', executedBy: actor.userId, executedAt: now } }).catch(() => undefined);
    logger.error('Falha ao anonimizar titular (nada foi alterado: a transação foi desfeita)', { requestId: request.id, error: (error as Error).name });
    throw new AppError('Não foi possível concluir a anonimização. Nada foi alterado. Tente novamente.', 500, 'ANONYMIZATION_FAILED');
  }
}

export async function listRequests(companyId: string) {
  const rows = await prisma.privacyRequest.findMany({ where: { companyId }, orderBy: { requestedAt: 'desc' }, take: 100 });
  return rows.map(summary);
}

export async function getRequest(companyId: string, id: string) {
  const row = await prisma.privacyRequest.findFirst({ where: { id, companyId } });
  if (!row) throw new AppError('Pedido não encontrado.', 404, 'REQUEST_NOT_FOUND');
  return summary(row);
}
