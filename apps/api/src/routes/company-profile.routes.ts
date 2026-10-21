import { Router, Request, Response, NextFunction } from 'express';
import { AuditAction } from '@ln-system/database';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { companyProfileService } from '../services/company-profile.service';
import { companyIdOf } from './policies.routes';

/**
 * Cadastro da própria empresa (razão social, fantasia, documentos, endereço, contatos, regime tributário).
 *  GET /company-profile — gerência+ lê
 *  PUT /company-profile — administração edita (CNPJ/CPF só o Super Admin)
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);

router.get('/', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await companyProfileService.get(companyIdOf(req)));
  } catch (error) {
    return next(error);
  }
});

router.put(
  '/',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Company', {
    describe: (_req, body) => ({
      entityId: body?.profile?.id ?? null,
      newValue: {
        campos: body?.changed ?? [],
        antes: Object.fromEntries((body?.changed ?? []).map((k: string) => [k, body?.before?.[k] ?? null])),
        depois: Object.fromEntries((body?.changed ?? []).map((k: string) => [k, body?.profile?.[k] ?? null])),
      },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await companyProfileService.update(companyIdOf(req), req.body, { userType: (req as any).user.userType });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
