import { Router, Request, Response, NextFunction } from 'express';
import { ZodError, ZodTypeAny, z } from 'zod';
import { AppError, AuthorizationError } from '@ln-system/shared';
import { AuditAction } from '@ln-system/database';
import { authMiddleware, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { idempotency } from '../middleware/idempotency';
import { requireWriteBranchId } from '../utils/branch-context';
import {
  SUPPLIER_RETURN_OUTCOMES,
  SUPPLIER_RETURN_REASONS,
  SUPPLIER_RETURN_STATUSES,
  SUPPLIER_RETURN_WRITER_TYPES,
  SupplierReturnActor,
  supplierReturnService,
} from '../services/supplier-return.service';

/**
 * Devolução ao fornecedor (docs/CORTEX/policies/DEVOLUCAO-FORNECEDOR.md) — NÃO é garantia ao cliente.
 *  GET  /supplier-returns?status=&supplierId=&branchId=&page=&limit=   lista (limit ≤ 100)
 *  GET  /supplier-returns/:id                                          detalhe: itens, histórico, movimentos, ações do usuário
 *  POST /supplier-returns                 { supplierId, branchId?, purchaseOrderId?, reason, description?, items[] }
 *  POST /supplier-returns/:id/approve     { notes? }            aprovador (política) ≠ solicitante; retira o estoque
 *  POST /supplier-returns/:id/reject      { reason }            aprovador (política) ≠ solicitante
 *  POST /supplier-returns/:id/send        { shippingInfo? }     operador+
 *  POST /supplier-returns/:id/close       { outcome, outcomeAmount?, outcomeNotes?, receivedItems? }   aprovador
 *  POST /supplier-returns/:id/cancel      { reason }            antes do envio; se aprovada, o estoque volta
 * Empresa vem do token; filial validada contra a empresa (requireWriteBranchId) e RLS FORCE empresa+filial.
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('COMPRAS'));
// MECHANIC (oficina) não lê compras/custos — mesma regra de purchase-orders.
router.use(denyUserTypes('MECHANIC'));

function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new AppError(e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '), 400, 'VALIDATION_ERROR');
    }
    throw e;
  }
}

function actorOf(req: Request): SupplierReturnActor {
  const u = (req as any).user;
  if (!u?.companyId) throw new AppError('Empresa não identificada', 400, 'COMPANY_CONTEXT_REQUIRED');
  return { userId: u.userId, userType: u.userType, companyId: u.companyId, branchId: u.branchId ?? null };
}

/** VIEWER só consulta: a escrita é recusada com mensagem clara (antes de validar o corpo). */
function requireWriter(req: Request, _res: Response, next: NextFunction) {
  const t = (req as any).user?.userType;
  if (!(SUPPLIER_RETURN_WRITER_TYPES as readonly string[]).includes(t)) {
    return next(
      new AuthorizationError(
        'Seu perfil só consulta devoluções ao fornecedor. Peça a um operador, gerente ou administrador para registrar.',
        'SUPPLIER_RETURN_FORBIDDEN'
      )
    );
  }
  return next();
}

const text = (max: number) => z.string().trim().max(max, `Máximo ${max} caracteres`);
const reasonText = z.string().trim().min(5, 'Informe o motivo (mínimo 5 caracteres)').max(1000, 'Máximo 1000 caracteres');
const qty = z.number({ invalid_type_error: 'Quantidade precisa ser um número' }).positive('A quantidade precisa ser maior que zero').max(999_999, 'Quantidade muito alta');
const money = z.number().min(0, 'O valor não pode ser negativo').max(99_999_999, 'Valor muito alto');

const createSchema = z.object({
  supplierId: z.string().uuid('Fornecedor inválido'),
  branchId: z.string().uuid('Filial inválida').optional().nullable(),
  purchaseOrderId: z.string().uuid('Pedido de compra inválido').optional().nullable(),
  reason: z.enum(SUPPLIER_RETURN_REASONS, { errorMap: () => ({ message: 'Motivo inválido (DAMAGED, DEFECTIVE, WRONG_ITEM, NOT_ORDERED ou OTHER)' }) }),
  description: text(2000).optional().nullable(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid('Produto inválido'),
        quantity: qty,
        unitCost: money.optional().nullable(),
        notes: text(500).optional().nullable(),
        damageRecordId: z.string().uuid('Avaria inválida').optional().nullable(),
      })
    )
    .min(1, 'Inclua ao menos um produto')
    .max(200, 'Máximo de 200 itens por devolução'),
});

const approveSchema = z.object({ notes: text(1000).optional().nullable() });
const reasonSchema = z.object({ reason: reasonText });
const sendSchema = z.object({ shippingInfo: text(1000).optional().nullable() });
const closeSchema = z.object({
  outcome: z.enum(SUPPLIER_RETURN_OUTCOMES, { errorMap: () => ({ message: 'Resultado inválido (CREDIT, REPLACEMENT, REFUND ou REFUSED_BY_SUPPLIER)' }) }),
  outcomeAmount: money.optional().nullable(),
  outcomeNotes: text(2000).optional().nullable(),
  receivedItems: z.array(z.object({ productId: z.string().uuid('Produto inválido'), quantity: qty })).max(200).optional(),
});
const listQuery = z.object({
  status: z.enum(SUPPLIER_RETURN_STATUSES).optional(),
  supplierId: z.string().uuid('Fornecedor inválido').optional(),
  branchId: z.string().uuid('Filial inválida').optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100, 'Máximo 100 por página').optional(),
});

/** Auditoria de cada escrita: ação, número, status resultante e o que foi informado. */
const audit = (action: AuditAction, what: string, extra: (req: Request, body: any) => Record<string, unknown> = () => ({})) =>
  auditLog(action, 'SupplierReturn', {
    describe: (req, body) => ({
      entityId: body?.id ?? req.params.id,
      companyId: body?.companyId,
      newValue: { action: what, returnNumber: body?.returnNumber, status: body?.status, branchId: body?.branchId, ...extra(req, body) },
    }),
  });

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = parse(listQuery, req.query);
    return res.json(await supplierReturnService.list(actorOf(req), q));
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await supplierReturnService.getById(req.params.id, actorOf(req)));
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/',
  idempotency(),
  requireWriter,
  audit(AuditAction.CREATE, 'REQUEST_SUPPLIER_RETURN', (_req, body) => ({
    supplierId: body?.supplierId,
    reason: body?.reason,
    items: (body?.items ?? []).map((i: any) => ({ productId: i.productId, quantity: Number(i.quantity), damageRecordId: i.damageRecordId })),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(createSchema, req.body);
      const actor = actorOf(req);
      const branchId = await requireWriteBranchId(actor, data.branchId ?? undefined);
      const created = await supplierReturnService.create(actor, {
        branchId,
        supplierId: data.supplierId,
        purchaseOrderId: data.purchaseOrderId ?? null,
        reason: data.reason,
        description: data.description ?? null,
        items: data.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitCost: i.unitCost ?? null,
          notes: i.notes ?? null,
          damageRecordId: i.damageRecordId ?? null,
        })),
      });
      return res.status(201).json(created);
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/:id/approve',
  idempotency(),
  requireWriter,
  audit(AuditAction.UPDATE, 'APPROVE_SUPPLIER_RETURN', (req, body) => ({
    notes: req.body?.notes ?? null,
    stockWithdrawnAt: body?.stockWithdrawnAt,
    stockMovements: (body?.stockMovements ?? []).map((m: any) => ({ id: m.id, type: m.movementType, productId: m.productId, quantity: Number(m.quantity) })),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(approveSchema, req.body ?? {});
      return res.json(await supplierReturnService.approve(req.params.id, actorOf(req), data.notes ?? null));
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/:id/reject',
  idempotency(),
  requireWriter,
  audit(AuditAction.UPDATE, 'REJECT_SUPPLIER_RETURN', (req) => ({ reason: req.body?.reason })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(reasonSchema, req.body ?? {});
      return res.json(await supplierReturnService.reject(req.params.id, actorOf(req), data.reason));
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/:id/send',
  idempotency(),
  requireWriter,
  audit(AuditAction.UPDATE, 'SEND_SUPPLIER_RETURN', (req) => ({ shippingInfo: req.body?.shippingInfo ?? null })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(sendSchema, req.body ?? {});
      return res.json(await supplierReturnService.send(req.params.id, actorOf(req), data.shippingInfo ?? null));
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/:id/close',
  idempotency(),
  requireWriter,
  audit(AuditAction.UPDATE, 'CLOSE_SUPPLIER_RETURN', (req) => ({
    outcome: req.body?.outcome,
    outcomeAmount: req.body?.outcomeAmount ?? null,
    outcomeNotes: req.body?.outcomeNotes ?? null,
    receivedItems: req.body?.receivedItems ?? [],
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(closeSchema, req.body ?? {});
      return res.json(
        await supplierReturnService.close(req.params.id, actorOf(req), {
          outcome: data.outcome,
          outcomeAmount: data.outcomeAmount ?? null,
          outcomeNotes: data.outcomeNotes ?? null,
          receivedItems: data.receivedItems ?? [],
        })
      );
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/:id/cancel',
  idempotency(),
  requireWriter,
  audit(AuditAction.UPDATE, 'CANCEL_SUPPLIER_RETURN', (req) => ({ reason: req.body?.reason })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(reasonSchema, req.body ?? {});
      return res.json(await supplierReturnService.cancel(req.params.id, actorOf(req), data.reason));
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
