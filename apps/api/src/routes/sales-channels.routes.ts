import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@ln-system/shared';
import { AuditAction } from '@ln-system/database';
import { enqueueSync, outboxAdmin, type SyncKind } from '../services/integrations/outbox.service';
import salesChannelService from '../services/sales-channels/sales-channel.service';
import commerceCredentialService from '../services/commerce/credentials.service';
import commerceOrderService from '../services/commerce/order.service';
import publicationService from '../services/commerce/publication.service';
import reservationService from '../services/commerce/reservation.service';
import convertService, { fulfillmentService } from '../services/commerce/convert.service';
import { CommerceError } from '../services/commerce/errors';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';

/**
 * Canais de venda (docs/CORTEX/CANAIS.md). Só administração: SUPER_ADMIN (com empresa) e COMPANY_ADMIN. O módulo CANAIS nasce
 * desativado; enquanto estiver desligado para a empresa/filial, tudo aqui responde 403 `MODULE_DISABLED` (o Super Admin passa).
 * Credencial é só escrita: nenhuma resposta a devolve, e a auditoria registra só o NOME dos campos, nunca o valor.
 */
const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('CANAIS'));
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'));

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new AppError(r.error.issues.map((i) => i.message).join('; '), 400, 'VALIDATION_ERROR');
  return r.data;
}

const companyOf = (req: Request): string => {
  const id = req.user?.companyId;
  if (!id) throw new AppError('Empresa não identificada', 400, 'COMPANY_CONTEXT_REQUIRED');
  return id;
};
const actorOf = (req: Request): string => req.user!.userId;

const createSchema = z.object({
  type: z.enum(['LOJA_FISICA', 'SITE_PROPRIO', 'IFOOD', 'MARKETPLACE', 'OUTRO']),
  displayName: z.string().min(2, 'Informe o nome exibido').max(60),
  branchId: z.string().uuid().nullable().optional(),
  /** Provedor de integração registrado nesta instalação (Integration Gateway); omitido = o padrão do tipo. */
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional(),
});

// `type`, empresa e filial não mudam: campos desconhecidos (inclusive `type`) são recusados.
const updateSchema = z
  .object({
    displayName: z.string().min(2).max(60).optional(),
    isActive: z.boolean().optional(),
    externalAccountId: z.string().max(120).nullable().optional(),
    config: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

const credentialsSchema = z.object({ credentials: z.record(z.string()) }).strict();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
    res.json({ data: await salesChannelService.list(companyOf(req), { branchId }) });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/',
  auditLog(AuditAction.CREATE, 'SalesChannel', { describe: (req, body) => ({ entityId: (body as any)?.id ?? null, newValue: { type: req.body?.type, displayName: req.body?.displayName, branchId: req.body?.branchId ?? null } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(createSchema, req.body);
      res.status(201).json(await salesChannelService.create({ companyId: companyOf(req), actorId: actorOf(req), ...data }));
    } catch (e) {
      next(e);
    }
  }
);

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await salesChannelService.get(companyOf(req), req.params.id));
  } catch (e) {
    next(e);
  }
});

router.patch(
  '/:id',
  auditLog(AuditAction.UPDATE, 'SalesChannel', { describe: (req) => ({ entityId: req.params.id, newValue: { fields: Object.keys(req.body ?? {}), isActive: req.body?.isActive, displayName: req.body?.displayName } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(updateSchema, req.body);
      res.json(await salesChannelService.update({ companyId: companyOf(req), id: req.params.id, actorId: actorOf(req), ...data }));
    } catch (e) {
      next(e);
    }
  }
);

router.put(
  '/:id/credentials',
  auditLog(AuditAction.UPDATE, 'SalesChannel', { describe: (req) => ({ entityId: req.params.id, newValue: { credentialFields: Object.keys(req.body?.credentials ?? {}) } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { credentials } = parse(credentialsSchema, req.body);
      res.json(await salesChannelService.setCredentials({ companyId: companyOf(req), id: req.params.id, actorId: actorOf(req), credentials }));
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  '/:id/credentials',
  auditLog(AuditAction.UPDATE, 'SalesChannel', { describe: (req) => ({ entityId: req.params.id, newValue: { credentials: 'removidas' } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await salesChannelService.clearCredentials({ companyId: companyOf(req), id: req.params.id, actorId: actorOf(req) }));
    } catch (e) {
      next(e);
    }
  }
);

// 200 com `ok:false` quando não há provedor/credencial ou o provedor falhou: o pedido em si foi atendido; a tela mostra o motivo.
router.post('/:id/test-connection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await salesChannelService.testConnection({ companyId: companyOf(req), id: req.params.id, actorId: actorOf(req), correlationId: req.requestId }));
  } catch (e) {
    next(e);
  }
});

router.get('/:id/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Number(req.query.limit) || 50;
    res.json({ data: await salesChannelService.listEvents(companyOf(req), req.params.id, limit) });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// COMMERCE API — administração (docs/CORTEX/COMMERCE_API.md). Credenciais que o canal usa para chamar o CÓRTEX, publicação de
// produtos e pedidos recebidos. O segredo de uma credencial aparece UMA vez, na resposta da criação (ou da troca), e a auditoria
// nunca o recebe: o `newValue` é informado à mão, só com o identificador público e os escopos.
// ---------------------------------------------------------------------------------------------------------------------
const toAppError = (e: unknown) => (e instanceof CommerceError ? new AppError(e.message, e.status, e.code) : e);

const credentialCreateSchema = z
  .object({
    label: z.string().trim().min(2, 'Informe um nome para a credencial').max(60),
    scopes: z.array(z.enum(['CATALOG_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENT_EVENTS_WRITE'])).min(1, 'Informe ao menos um escopo').max(4),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();

router.get('/:id/api-credentials', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await commerceCredentialService.list(companyOf(req), req.params.id) });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/:id/api-credentials',
  auditLog(AuditAction.CREATE, 'ChannelApiCredential', { describe: (req, body) => ({ entityId: (body as any)?.credential?.id ?? null, newValue: { channelId: req.params.id, label: req.body?.label, scopes: req.body?.scopes, keyId: (body as any)?.credential?.keyId } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(credentialCreateSchema, req.body);
      const created = await commerceCredentialService.create({
        companyId: companyOf(req),
        channelId: req.params.id,
        label: data.label,
        scopes: data.scopes,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        actorId: actorOf(req),
        correlationId: req.requestId,
      });
      res.set('Cache-Control', 'no-store').status(201).json(created);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/:id/api-credentials/:credentialId/rotate',
  auditLog(AuditAction.UPDATE, 'ChannelApiCredential', { describe: (req, body) => ({ entityId: req.params.credentialId, newValue: { channelId: req.params.id, rotatedTo: (body as any)?.credential?.keyId } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hours = req.body?.overlapHours === undefined ? undefined : Number(req.body.overlapHours);
      if (hours !== undefined && (!Number.isFinite(hours) || hours < 0 || hours > 168)) throw new AppError('overlapHours deve estar entre 0 e 168', 400, 'VALIDATION_ERROR');
      const rotated = await commerceCredentialService.rotate({ companyId: companyOf(req), channelId: req.params.id, credentialId: req.params.credentialId, actorId: actorOf(req), overlapHours: hours, correlationId: req.requestId });
      res.set('Cache-Control', 'no-store').status(201).json(rotated);
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  '/:id/api-credentials/:credentialId',
  auditLog(AuditAction.UPDATE, 'ChannelApiCredential', { describe: (req) => ({ entityId: req.params.credentialId, newValue: { channelId: req.params.id, revoked: true } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await commerceCredentialService.revoke({ companyId: companyOf(req), channelId: req.params.id, credentialId: req.params.credentialId, actorId: actorOf(req), correlationId: req.requestId }));
    } catch (e) {
      next(e);
    }
  }
);

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get('/:id/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = parse(pageQuery, req.query);
    const published = req.query.published === undefined ? undefined : req.query.published === 'true';
    res.json(await publicationService.list(companyOf(req), req.params.id, { page, limit, published }));
  } catch (e) {
    next(e);
  }
});

const publishSchema = z.object({ skus: z.array(z.string().trim().min(1).max(80)).min(1).max(500), published: z.boolean() }).strict();

router.put(
  '/:id/products',
  auditLog(AuditAction.UPDATE, 'ChannelProductLink', { describe: (req, body) => ({ entityId: req.params.id, newValue: { published: req.body?.published, count: (body as any)?.updated, unknown: ((body as any)?.unknownSkus ?? []).length } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(publishSchema, req.body);
      res.json(await publicationService.setPublished({ companyId: companyOf(req), channelId: req.params.id, skus: data.skus, published: data.published, actorId: actorOf(req), correlationId: req.requestId }));
    } catch (e) {
      next(e);
    }
  }
);

router.get('/:id/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = parse(pageQuery, req.query);
    const status = typeof req.query.status === 'string' && ['RECEIVED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'CONVERTED', 'EXPIRED'].includes(req.query.status) ? (req.query.status as any) : undefined;
    res.json(await commerceOrderService.listForChannel(companyOf(req), req.params.id, { status, page, limit }));
  } catch (e) {
    next(toAppError(e));
  }
});

router.get('/:id/orders/:orderId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await commerceOrderService.getForAdmin(companyOf(req), req.params.id, req.params.orderId) });
  } catch (e) {
    next(toAppError(e));
  }
});

const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Informe o motivo').max(500) }).strict();

// Aceitar = RESERVAR estoque (tudo ou nada). O prazo da reserva é decisão comercial e não tem valor padrão: o canal precisa tê-lo configurado.
router.post(
  '/:id/orders/:orderId/accept',
  auditLog(AuditAction.UPDATE, 'ExternalOrder', { describe: (req) => ({ entityId: req.params.orderId, newValue: { status: 'ACCEPTED' } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await reservationService.acceptOrder({ companyId: companyOf(req), channelId: req.params.id, orderId: req.params.orderId, actor: { type: 'USER', userId: actorOf(req) }, correlationId: req.requestId });
      res.json({ data: r.order, replayed: r.replayed, expiresAt: r.expiresAt });
    } catch (e) {
      next(toAppError(e));
    }
  }
);

// Converter = o pedido vira VENDA (uma transação, idempotente). Exige pagamento confirmado cobrindo o total. Sem caixa físico.
router.post(
  '/:id/orders/:orderId/convert',
  auditLog(AuditAction.CREATE, 'Sale', { describe: (req, body) => ({ entityId: (body as any)?.sale?.id ?? null, newValue: { fromOrder: req.params.orderId, saleNumber: (body as any)?.sale?.saleNumber } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await convertService.convertOrder({ companyId: companyOf(req), channelId: req.params.id, orderId: req.params.orderId, actor: { type: 'USER', userId: actorOf(req) }, correlationId: req.requestId });
      res.status(r.replayed ? 200 : 201).json({ data: r.order, sale: r.sale, replayed: r.replayed });
    } catch (e) {
      next(toAppError(e));
    }
  }
);

const fulfillmentSchema = z
  .object({
    status: z.enum(['READY', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED', 'CANCELLED']),
    type: z.enum(['PICKUP', 'OWN_DELIVERY', 'CHANNEL_DELIVERY']).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

router.patch(
  '/:id/orders/:orderId/fulfillment',
  auditLog(AuditAction.UPDATE, 'Fulfillment', { describe: (req) => ({ entityId: req.params.orderId, newValue: { status: req.body?.status, type: req.body?.type } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(fulfillmentSchema, req.body);
      const f = await fulfillmentService.transition({ companyId: companyOf(req), channelId: req.params.id, orderId: req.params.orderId, ...data, actorId: actorOf(req), correlationId: req.requestId });
      res.json({ data: { status: f.status, type: f.type, statusChangedAt: f.statusChangedAt, notes: f.notes } });
    } catch (e) {
      next(toAppError(e));
    }
  }
);

router.post(
  '/:id/orders/:orderId/reject',
  auditLog(AuditAction.UPDATE, 'ExternalOrder', { describe: (req) => ({ entityId: req.params.orderId, newValue: { status: 'REJECTED', reason: req.body?.reason } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reason } = parse(reasonSchema, req.body);
      res.json({ data: await commerceOrderService.rejectByAdmin({ companyId: companyOf(req), channelId: req.params.id, orderId: req.params.orderId, reason, actorId: actorOf(req), correlationId: req.requestId }) });
    } catch (e) {
      next(toAppError(e));
    }
  }
);

router.post(
  '/:id/orders/:orderId/cancel',
  auditLog(AuditAction.UPDATE, 'ExternalOrder', { describe: (req) => ({ entityId: req.params.orderId, newValue: { status: 'CANCELLED', reason: req.body?.reason } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reason } = parse(reasonSchema, req.body);
      res.json({ data: await commerceOrderService.cancelByAdmin({ companyId: companyOf(req), channelId: req.params.id, orderId: req.params.orderId, reason, actorId: actorOf(req), correlationId: req.requestId }) });
    } catch (e) {
      next(toAppError(e));
    }
  }
);

// ---------------------------------------------------------------------------------------------------------------------
// Integration Gateway (Fase 3): caixa de saída e sincronização. Só COMPANY_ADMIN e SUPER_ADMIN (como o resto do módulo).
// ---------------------------------------------------------------------------------------------------------------------
router.get('/:id/outbox', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(await outboxAdmin.list(companyOf(req), req.params.id, { status, limit }));
  } catch (e) {
    next(toAppError(e));
  }
});

router.post(
  '/:id/outbox/:rowId/retry',
  auditLog(AuditAction.UPDATE, 'ChannelOutbox', { describe: (req) => ({ entityId: req.params.rowId, newValue: { action: 'RETRY' } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await outboxAdmin.retry(companyOf(req), req.params.id, req.params.rowId, actorOf(req)));
    } catch (e) {
      next(toAppError(e));
    }
  }
);

router.post(
  '/:id/outbox/:rowId/cancel',
  auditLog(AuditAction.UPDATE, 'ChannelOutbox', { describe: (req) => ({ entityId: req.params.rowId, newValue: { action: 'CANCEL' } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await outboxAdmin.cancel(companyOf(req), req.params.id, req.params.rowId, actorOf(req)));
    } catch (e) {
      next(toAppError(e));
    }
  }
);

// Enfileira o envio do catálogo publicado (estoque disponível, preço ou cadastro) ao provedor do canal. O CÓRTEX é o mestre: só envia.
router.post(
  '/:id/sync/:kind',
  auditLog(AuditAction.UPDATE, 'SalesChannel', { describe: (req) => ({ entityId: req.params.id, newValue: { sync: req.params.kind } }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const kind = String(req.params.kind).toUpperCase();
      if (!['INVENTORY', 'PRICE', 'CATALOG'].includes(kind)) throw new AppError('Tipo de sincronização inválido', 400, 'INVALID_SYNC_KIND');
      res.status(202).json({ data: await enqueueSync({ companyId: companyOf(req), channelId: req.params.id, kind: kind as SyncKind, correlationId: req.requestId }) });
    } catch (e) {
      next(toAppError(e));
    }
  }
);

export default router;
