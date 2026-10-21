import { Router, Request, Response } from 'express';
import revisionService from '../services/revision.service';
import { createRevisionSchema, revisionFilterSchema } from '@ln-system/shared/src/validators/revision.validators';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { resolveWriteBranchId } from '../utils/branch-context';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('POS_VENDA'));

router.get('/', async (req: Request, res: Response) => {
  try {
    const filters = revisionFilterSchema.parse({
      ...req.query,
      companyId: (req as any).user.companyId,
      page: req.query.page,
      limit: req.query.limit,
    });
    const result = await revisionService.list({
      companyId: filters.companyId!,
      branchId: filters.branchId,
      customerId: filters.customerId,
      motorcycleId: filters.motorcycleId,
      dueBefore: filters.dueBefore ? new Date(filters.dueBefore) : undefined,
      page: filters.page,
      limit: filters.limit,
    });
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const revision = await revisionService.getById(req.params.id, (req as any).user.companyId);
    if (!revision) {
      return res.status(404).json({ error: 'Revision not found' });
    }
    return res.json(revision);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA: mesmo achado de appointments.routes.ts — o único
// write deste arquivo não tinha trava de papel, inclusive VIEWER
// conseguia registrar uma revisão. Exclui só o VIEWER (registro de
// revisão é tarefa operacional real de MECHANIC/OPERATOR).
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'));

router.post('/', auditLog(AuditAction.CREATE, 'Revision'), async (req: Request, res: Response) => {
  try {
    // Filial resolvida a partir do token (ver utils/branch-context.ts): usuário de filial
    // grava na filial dele; sem isso o registro nascia NULL e a TV/mobile nunca o via.
    const branchId = await resolveWriteBranchId((req as any).user, req.body?.branchId);
    const data = createRevisionSchema.parse({
      ...req.body,
      branchId,
      companyId: (req as any).user.companyId,
      recordedBy: (req as any).user.userId,
    });
    const revision = await revisionService.create({
      ...data,
      performedAt: new Date(data.performedAt),
    });
    res.status(201).json(revision);
  } catch (error: any) {
    res.status(error.statusCode ?? 400).json({ error: error.message });
  }
});

export default router;
