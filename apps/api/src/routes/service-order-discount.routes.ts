import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuditAction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { idempotency } from '../middleware/idempotency';
import { rateLimitAuthorizer } from '../middlewares/advancedRateLimit';
import serviceOrderDiscountService from '../services/service-order-discount.service';

/**
 * Desconto da ordem de serviço (docs/CORTEX/policies/DESCONTO.md), montado em /service-orders ao lado das rotas da OS
 * (arquivo próprio para não disputar service-orders.routes.ts com outras áreas).
 *  GET  /service-orders/:id/discount  — desconto vigente por tipo + histórico (discount_events)
 *  POST /service-orders/:id/discount  — { partsDiscount, laborDiscount, reason?, authorizerNumericId?, authorizerPassword?, authorizerMfaCode? }
 * Erros: 409 DISCOUNT_AUTHORIZATION_REQUIRED (com `details`), 409 DISCOUNT_LIMIT_EXCEEDED, 409 SERVICE_ORDER_ALREADY_PAID,
 * 409 SERVICE_ORDER_CLOSED, 409 SERVICE_ORDER_CHANGED, 400 DISCOUNT_EXCEEDS_TOTAL / DISCOUNT_REASON_REQUIRED / INVALID_DISCOUNT.
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('OFICINA'));

// Quem lança valores na OS (balcão/gerência/administração). Mecânico não concede desconto.
const DISCOUNT_WRITERS = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'];

const bodySchema = z.object({
  partsDiscount: z.number().min(0).finite().default(0),
  laborDiscount: z.number().min(0).finite().default(0),
  reason: z.string().max(500).nullish(),
  authorizerNumericId: z.number().int().positive().nullish(),
  authorizerPassword: z.string().nullish(),
  authorizerMfaCode: z.string().nullish(),
});

function sendError(res: Response, next: NextFunction, error: any) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ ...error.toJSON(), error: error.message });
  }
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.') || 'dados'}: ${i.message}`).join('; '), code: 'VALIDATION_ERROR' });
  }
  // Recusas do autorizador (verifyDualAuthorization lança Error puro, traduzido na saída): 400, como nas demais rotas.
  if (error instanceof Error && !(error as any).code) {
    return res.status(400).json({ error: error.message });
  }
  return next(error);
}

router.get('/:id/discount', requireUserType(...DISCOUNT_WRITERS, 'VIEWER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    return res.json(await serviceOrderDiscountService.getDiscount(req.params.id, user.companyId, { branchId: user.branchId }));
  } catch (error) {
    return sendError(res, next, error);
  }
});

router.post(
  '/:id/discount',
  requireUserType(...DISCOUNT_WRITERS),
  rateLimitAuthorizer,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'ServiceOrder', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        operacao: 'DESCONTO_OS',
        descontoPecas: body?.partsDiscount ?? null,
        descontoMaoDeObra: body?.laborDiscount ?? null,
        descontoTotal: body?.discountAmount ?? null,
        exigiuAutorizacao: body?.requiredAuthorization ?? null,
        autorizadoPor: body?.authorizer?.id ?? null,
        motivo: req.body?.reason ?? null,
      },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const data = bodySchema.parse(req.body ?? {});
      const result = await serviceOrderDiscountService.applyDiscount({
        serviceOrderId: req.params.id,
        companyId: user.companyId,
        requester: { userId: user.userId, userType: user.userType, branchId: user.branchId },
        partsDiscount: data.partsDiscount,
        laborDiscount: data.laborDiscount,
        reason: data.reason,
        authorizerNumericId: data.authorizerNumericId,
        authorizerPassword: data.authorizerPassword,
        authorizerMfaCode: data.authorizerMfaCode,
        requestId: (req as any).requestId,
        device: req.headers['x-device-type'] as string | undefined,
      });
      return res.json(result);
    } catch (error) {
      return sendError(res, next, error);
    }
  }
);

export default router;
