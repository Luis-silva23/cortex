import { Router, Request, Response, NextFunction } from 'express';
import auditLogService from '../services/audit-log.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { rateLimitGeneral } from '../middlewares/advancedRateLimit';
import { AuditAction } from '@ln-system/database';

const router = Router();

// Só quem administra (Super Admin vê tudo; Company Admin/Manager só a
// própria empresa, forçado abaixo — mesmo critério de acesso a
// configuração sensível já usado em discount-rules/commission-rules).
router.use(authMiddleware, tenantIsolation, rateLimitGeneral, requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'));

function parsePage(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    // Company Admin/Manager nunca podem pedir companyId de outra empresa —
    // ignoramos qualquer valor vindo do cliente e forçamos o próprio.
    const companyId = user.userType === 'SUPER_ADMIN' ? (req.query.companyId as string) : user.companyId;

    // Ação fora do enum ia direto ao Prisma (500 "Erro interno").
    const action = req.query.action;
    if (action !== undefined && action !== '' && !(Object.values(AuditAction) as unknown[]).includes(action)) {
      return res.status(400).json({ success: false, error: 'Ação de auditoria inválida no filtro "action"' });
    }

    const result = await auditLogService.list({
      companyId,
      userId: req.query.userId as string,
      action: req.query.action as string,
      entity: req.query.entity as string,
      entityId: req.query.entityId as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      page: parsePage(req.query.page),
      limit: parsePage(req.query.limit),
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
});

router.get('/entity/:entity/:entityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const companyId = user.userType === 'SUPER_ADMIN' ? undefined : user.companyId;
    const result = await auditLogService.listForEntity(req.params.entity, req.params.entityId, companyId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const companyId = user.userType === 'SUPER_ADMIN' ? undefined : user.companyId;
    const row = await auditLogService.getById(req.params.id, companyId);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Registro de auditoria não encontrado' });
    }
    return res.json({ success: true, data: row });
  } catch (error) {
    return next(error);
  }
});

export default router;
