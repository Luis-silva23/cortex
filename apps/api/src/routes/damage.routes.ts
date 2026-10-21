import { Router, Request, Response } from 'express';
import damageService from '../services/damage.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('ESTOQUE'));

const VALID_REASONS = ['EXPIRED', 'DAMAGED', 'LOST', 'THEFT'];

// Registrar avaria — só Gerente/Admin da empresa/Super Admin (seção 34 do
// prompt mestre): a permissão para chegar aqui já É a aprovação exigida.
router.post(
  '/',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.CREATE, 'DamageRecord'),
  async (req: Request, res: Response) => {
    try {
      const { branchId, productId, quantity, reason, description, photoUrls } = req.body;
      if (!branchId || !productId || !quantity || !reason) {
        return res.status(400).json({ error: 'branchId, productId, quantity e reason são obrigatórios' });
      }
      if (!VALID_REASONS.includes(reason)) {
        return res.status(400).json({ error: `reason inválido — use um de: ${VALID_REASONS.join(', ')}` });
      }
      const damage = await damageService.record({
        companyId: (req as any).user.companyId,
        branchId,
        productId,
        quantity: Number(quantity),
        reason,
        description,
        photoUrls,
        recordedBy: (req as any).user.userId,
      });
      return res.status(201).json(damage);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await damageService.list((req as any).user.companyId, {
      branchId: req.query.branchId as string | undefined,
      productId: req.query.productId as string | undefined,
      isReversed: req.query.isReversed !== undefined ? req.query.isReversed === 'true' : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const damage = await damageService.getById(req.params.id, (req as any).user.companyId);
    res.json(damage);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

router.post(
  '/:id/reverse',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.UPDATE, 'DamageRecord'),
  async (req: Request, res: Response) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ error: 'reason é obrigatório' });
      }
      const damage = await damageService.reverse({
        damageId: req.params.id,
        companyId: (req as any).user.companyId,
        reversedBy: (req as any).user.userId,
        reason,
      });
      return res.json(damage);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

export default router;
