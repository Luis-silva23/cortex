import { Router, Request, Response } from 'express';
import followUpService from '../services/follow-up.service';
import {
  createFollowUpSchema,
  followUpFilterSchema,
  logFollowUpContactSchema,
  declineOrCancelFollowUpSchema,
} from '@ln-system/shared/src/validators/revision.validators';
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

// Dashboard de pós-venda — exatamente os 3 baldes do domínio (seção 28).
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const result = await followUpService.dashboard(
      (req as any).user.companyId,
      req.query.branchId as string | undefined
    );
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const filters = followUpFilterSchema.parse({
      ...req.query,
      companyId: (req as any).user.companyId,
    });
    const result = await followUpService.list({
      companyId: filters.companyId!,
      branchId: filters.branchId,
      status: filters.status,
      customerId: filters.customerId,
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
    const followUp = await followUpService.getById(req.params.id, (req as any).user.companyId);
    if (!followUp) {
      return res.status(404).json({ error: 'Follow-up not found' });
    }
    return res.json(followUp);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA: mesmo achado de appointments.routes.ts — nenhum
// write tinha trava de papel, inclusive VIEWER conseguia criar/contatar/
// aceitar/recusar/cancelar qualquer follow-up. Exclui só o VIEWER (fluxo
// operacional real de pós-venda, usado por OPERATOR/MECHANIC).
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'));

router.post('/', auditLog(AuditAction.CREATE, 'FollowUp'), async (req: Request, res: Response) => {
  try {
    // Filial resolvida a partir do token (ver utils/branch-context.ts): usuário de filial
    // grava na filial dele; sem isso o registro nascia NULL e a TV/mobile nunca o via.
    const branchId = await resolveWriteBranchId((req as any).user, req.body?.branchId);
    const data = createFollowUpSchema.parse({
      ...req.body,
      branchId,
      companyId: (req as any).user.companyId,
      createdBy: (req as any).user.userId,
    });
    const followUp = await followUpService.create({ ...data, dueDate: new Date(data.dueDate) });
    res.status(201).json(followUp);
  } catch (error: any) {
    res.status(error.statusCode ?? 400).json({ error: error.message });
  }
});

router.post('/:id/contact', auditLog(AuditAction.UPDATE, 'FollowUp'), async (req: Request, res: Response) => {
  try {
    const data = logFollowUpContactSchema.parse({ ...req.body, performedBy: (req as any).user.userId });
    const event = await followUpService.logContact(req.params.id, (req as any).user.companyId, data);
    res.status(201).json(event);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/:id/accept', auditLog(AuditAction.UPDATE, 'FollowUp'), async (req: Request, res: Response) => {
  try {
    const data = declineOrCancelFollowUpSchema.parse({ ...req.body, performedBy: (req as any).user.userId });
    const event = await followUpService.recordAcceptance(req.params.id, (req as any).user.companyId, {
      performedBy: data.performedBy,
      notes: data.reason,
    });
    res.json(event);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/:id/decline', auditLog(AuditAction.UPDATE, 'FollowUp'), async (req: Request, res: Response) => {
  try {
    const data = declineOrCancelFollowUpSchema.parse({ ...req.body, performedBy: (req as any).user.userId });
    const followUp = await followUpService.decline(req.params.id, (req as any).user.companyId, data);
    res.json(followUp);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/:id/cancel', auditLog(AuditAction.UPDATE, 'FollowUp'), async (req: Request, res: Response) => {
  try {
    const data = declineOrCancelFollowUpSchema.parse({ ...req.body, performedBy: (req as any).user.userId });
    const followUp = await followUpService.cancel(req.params.id, (req as any).user.companyId, data);
    res.json(followUp);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
