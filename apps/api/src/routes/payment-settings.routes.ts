import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import paymentSettingsService from '../services/payment-settings.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);

// Empresa do token; só o SUPER_ADMIN escolhe (por ?companyId ou no corpo).
function resolveCompanyId(req: Request): string | undefined {
  const user = (req as any).user;
  if (user.userType === 'SUPER_ADMIN') return (req.query.companyId as string) || req.body?.companyId || undefined;
  return user.companyId;
}

// Efetivo para a filial do token (o PDV precisa saber se pede as cédulas); admin pode consultar outra por ?branchId.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'companyId é obrigatório para SUPER_ADMIN' });
    const isAdmin = user.userType === 'SUPER_ADMIN' || user.userType === 'COMPANY_ADMIN';
    const branchId = (isAdmin ? (req.query.branchId as string) || user.branchId : user.branchId) || null;
    return res.json(await paymentSettingsService.getEffective(companyId, branchId));
  } catch (error) {
    return next(error);
  }
});

const setSchema = z.object({
  branchId: z.string().uuid().nullable().optional(),
  cashDenominationControl: z.boolean().nullable().optional(),
  cardProvider: z.string().min(1).max(40).nullable().optional(),
  pixProvider: z.string().min(1).max(40).nullable().optional(),
  terminalId: z.string().min(1).max(80).nullable().optional(),
});

router.put(
  '/',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.UPDATE, 'PaymentSetting', {
    describe: (req, body) => ({
      entityId: req.body?.branchId ?? resolveCompanyId(req) ?? null,
      newValue: { request: req.body ?? null, effective: body },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      const companyId = resolveCompanyId(req);
      if (!companyId) return res.status(400).json({ error: 'companyId é obrigatório para SUPER_ADMIN' });
      const data = setSchema.parse(req.body);
      const { branchId, ...fields } = data;
      const effective = await paymentSettingsService.set({ companyId, branchId: branchId ?? null, ...fields, actorId: (req as any).user.userId });
      return res.json(effective);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

export default router;
