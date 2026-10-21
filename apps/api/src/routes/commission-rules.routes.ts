import { Router, Request, Response } from 'express';
import { prisma } from '@ln-system/database';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

/**
 * CRUD de `CommissionRule` — sem isso, `ServiceOrderService.registerPayment`
 * nunca encontra uma regra ativa (`commissionRule` sempre `null`) e a
 * criação de `MechanicCommission` fica inalcançável na prática, mesmo já
 * implementada. Gap real, corrigido na FASE 27.
 */
const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('OFICINA'));

// Só Gerente/Admin/Super Admin definem a política de comissão da empresa.
router.use(requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'));

router.get('/', async (req: Request, res: Response) => {
  try {
    const rules = await prisma.commissionRule.findMany({
      where: { companyId: (req as any).user.companyId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ rules });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/', auditLog(AuditAction.CREATE, 'CommissionRule'), async (req: Request, res: Response) => {
  try {
    const { name, serviceType, percentage } = req.body;
    if (!name || percentage === undefined || percentage === null) {
      return res.status(400).json({ error: 'name e percentage são obrigatórios' });
    }
    if (Number(percentage) < 0 || Number(percentage) > 100) {
      return res.status(400).json({ error: 'percentage deve estar entre 0 e 100' });
    }
    const rule = await prisma.commissionRule.create({
      data: {
        companyId: (req as any).user.companyId,
        name,
        serviceType: serviceType || null,
        percentage: Number(percentage),
      },
    });
    return res.status(201).json(rule);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.put('/:id', auditLog(AuditAction.UPDATE, 'CommissionRule'), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.commissionRule.findFirst({
      where: { id: req.params.id, companyId: (req as any).user.companyId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Regra de comissão não encontrada' });
    }
    const { name, serviceType, percentage, isActive } = req.body;
    if (percentage !== undefined && (Number(percentage) < 0 || Number(percentage) > 100)) {
      return res.status(400).json({ error: 'percentage deve estar entre 0 e 100' });
    }
    const rule = await prisma.commissionRule.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name }),
        ...(serviceType !== undefined && { serviceType }),
        ...(percentage !== undefined && { percentage: Number(percentage) }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
    });
    return res.json(rule);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'CommissionRule'), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.commissionRule.findFirst({
      where: { id: req.params.id, companyId: (req as any).user.companyId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Regra de comissão não encontrada' });
    }
    // Desativa em vez de apagar — comissões já geradas guardam um snapshot
    // da regra (`ruleSnapshot`) e não dependem da linha continuar existindo,
    // mas apagar perderia o histórico de auditoria de "qual regra existiu".
    await prisma.commissionRule.update({ where: { id: existing.id }, data: { isActive: false } });
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

export default router;
