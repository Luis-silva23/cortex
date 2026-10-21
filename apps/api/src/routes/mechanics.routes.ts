import { Router, Request, Response } from 'express';
import mechanicService from '../services/mechanic.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('OFICINA'));

// Um MECHANIC só enxerga as PRÓPRIAS comissões: antes qualquer usuário do tenant
// listava as de todos (com ?mechanicId= livre) e lia o resumo pendente de
// qualquer colega. `comissão` é dinheiro de cada um; gerência+ continua vendo tudo.
router.get('/commissions', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = await mechanicService.listCommissions(user.companyId, {
      mechanicId: user.userType === 'MECHANIC' ? user.userId : (req.query.mechanicId as string | undefined),
      isPaid: req.query.isPaid !== undefined ? req.query.isPaid === 'true' : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    });
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id/commissions/pending-summary', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.userType === 'MECHANIC' && req.params.id !== user.userId) {
      return res.status(403).json({ error: 'Mecânico só consulta as próprias comissões' });
    }
    const summary = await mechanicService.getPendingSummary(user.companyId, req.params.id);
    return res.json(summary);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Liquidar comissão — ação financeira, restrita.
router.post(
  '/commissions/:id/pay',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.UPDATE, 'MechanicCommission'),
  async (req: Request, res: Response) => {
    try {
      const commission = await mechanicService.payCommission(req.params.id, (req as any).user.companyId);
      return res.json(commission);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

export default router;
