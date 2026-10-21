import { Router, Request, Response, NextFunction } from 'express';
import { ZodError, ZodTypeAny, z } from 'zod';
import { AppError } from '@ln-system/shared';
import { AuditAction } from '@ln-system/database';
import {
  decideWarrantyClaimSchema,
  openWarrantyClaimSchema,
  warrantyListQuerySchema,
} from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { warrantyService } from '../services/warranty.service';

/**
 * Garantias de OS (docs/CORTEX/policies/GARANTIA.md). A garantia nasce no encerramento da OS
 * (POST /service-orders/:id/status); aqui ficam a consulta e as ocorrências.
 *  GET   /warranties?customerId=&motorcycleId=&serviceOrderId=&status=ACTIVE|EXPIRED&km=  — qualquer usuário da oficina
 *  GET   /warranties/:id?km=                                                            — idem
 *  POST  /warranties/:id/claims { description, kmAtClaim? }                             — oficina (exceto VIEWER)
 *  PATCH /warranties/claims/:id { status, decisionNotes, newServiceOrderId? }           — gerência+
 * Empresa e filial vêm do token (RLS FORCE em service_order_warranties/warranty_claims), nunca do corpo/query.
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('OFICINA'));

const requireWorkshopWriter = requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC');
const requireManager = requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER');

/** Erro de validação vira 400 legível ("campo: mensagem") com código, em vez do blob do Zod. */
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

function companyIdOf(req: Request): string {
  const companyId = (req as any).user?.companyId;
  if (!companyId) throw new AppError('Empresa não identificada', 400, 'COMPANY_CONTEXT_REQUIRED');
  return companyId;
}

const kmQuery = z.object({ km: z.coerce.number().min(0).max(9_999_999).optional() });

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = parse(warrantyListQuerySchema, req.query);
    return res.json(await warrantyService.list({ companyId: companyIdOf(req), ...q }));
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { km } = parse(kmQuery, req.query);
    return res.json(await warrantyService.getById(req.params.id, companyIdOf(req), km));
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/:id/claims',
  requireWorkshopWriter,
  auditLog(AuditAction.CREATE, 'WarrantyClaim', {
    describe: (req, body) => ({
      entityId: body?.id,
      newValue: {
        action: 'OPEN_WARRANTY_CLAIM',
        warrantyId: req.params.id,
        serviceOrderId: body?.serviceOrderId,
        description: body?.description,
        kmAtClaim: body?.kmAtClaim != null ? Number(body.kmAtClaim) : null,
      },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(openWarrantyClaimSchema, req.body);
      const claim = await warrantyService.openClaim({
        companyId: companyIdOf(req),
        warrantyId: req.params.id,
        description: data.description,
        kmAtClaim: data.kmAtClaim ?? null,
        userId: (req as any).user.userId,
      });
      return res.status(201).json(claim);
    } catch (error) {
      return next(error);
    }
  }
);

router.patch(
  '/claims/:id',
  requireManager,
  auditLog(AuditAction.UPDATE, 'WarrantyClaim', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        action: 'DECIDE_WARRANTY_CLAIM',
        status: body?.status,
        decisionNotes: body?.decisionNotes,
        newServiceOrderId: body?.newServiceOrderId ?? null,
        warrantyId: body?.warrantyId,
      },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parse(decideWarrantyClaimSchema, req.body);
      const claim = await warrantyService.decideClaim({
        companyId: companyIdOf(req),
        claimId: req.params.id,
        status: data.status,
        decisionNotes: data.decisionNotes,
        newServiceOrderId: data.newServiceOrderId ?? null,
        userId: (req as any).user.userId,
      });
      return res.json(claim);
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
