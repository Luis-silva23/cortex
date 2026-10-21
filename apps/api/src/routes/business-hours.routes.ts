import { Router, Request, Response, NextFunction } from 'express';
import { AppError } from '@ln-system/shared';
import { AuditAction } from '@ln-system/database';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { businessHoursService } from '../services/business-hours.service';
import { companyIdOf, readableBranchId } from './policies.routes';

/**
 * Horário de funcionamento e calendário por empresa/filial.
 *  GET    /business-hours?branchId=          — semana efetiva, semana da empresa, exceções, fuso
 *  GET    /business-hours/check?at=ISO&branchId= — funcionando naquele instante?
 *  PUT    /business-hours                    — { branchId?, days[7] } (administração)
 *  DELETE /business-hours?branchId=          — filial volta ao horário da empresa (administração)
 *  POST   /business-hours/exceptions         — { branchId?, date, kind, opensAt?, closesAt?, description? } (administração)
 *  DELETE /business-hours/exceptions/:id     — (administração)
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);

const ADMIN = requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN');

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchId = await readableBranchId(req);
    return res.json({ branchId, ...(await businessHoursService.getSchedule(companyIdOf(req), branchId)) });
  } catch (error) {
    return next(error);
  }
});

router.get('/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    if (Number.isNaN(at.getTime())) throw new AppError('Data/hora inválida (use ISO 8601)', 400, 'INVALID_DATE');
    const branchId = await readableBranchId(req);
    return res.json({ branchId, at: at.toISOString(), ...(await businessHoursService.isOpenAt(companyIdOf(req), branchId, at)) });
  } catch (error) {
    return next(error);
  }
});

router.put(
  '/',
  ADMIN,
  auditLog(AuditAction.UPDATE, 'BusinessHours', {
    describe: (_req, body) => ({ entityId: body?.branchId ?? 'empresa', newValue: { filial: body?.branchId ?? null, antes: body?.before ?? null, depois: body?.after ?? null } }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await businessHoursService.setWeek({
        companyId: companyIdOf(req),
        branchId: req.body?.branchId ?? null,
        days: req.body?.days,
        userId: (req as any).user.userId,
      });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  }
);

router.delete(
  '/',
  ADMIN,
  auditLog(AuditAction.DELETE, 'BusinessHours', { describe: (_req, body) => ({ entityId: body?.branchId ?? null, newValue: body }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = req.query.branchId as string | undefined;
      if (!branchId) throw new AppError('Informe a filial (o horário da empresa é alterado, não removido)', 400, 'BRANCH_REQUIRED');
      return res.json(await businessHoursService.clearBranchWeek(companyIdOf(req), branchId));
    } catch (error) {
      return next(error);
    }
  }
);

router.post('/exceptions', ADMIN, auditLog(AuditAction.CREATE, 'BusinessCalendarException'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { branchId, ...data } = req.body ?? {};
    const created = await businessHoursService.addException({ companyId: companyIdOf(req), branchId: branchId ?? null, data, userId: (req as any).user.userId });
    return res.status(201).json(created);
  } catch (error) {
    return next(error);
  }
});

router.delete('/exceptions/:id', ADMIN, auditLog(AuditAction.DELETE, 'BusinessCalendarException'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await businessHoursService.removeException(companyIdOf(req), req.params.id));
  } catch (error) {
    return next(error);
  }
});

export default router;
