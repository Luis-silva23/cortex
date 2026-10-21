import { Router } from 'express';
import installmentPolicyService from '../services/installment-policy.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware, tenantIsolation);
router.use(requireModuleEnabled('VENDAS'));

router.get('/', async (req, res, next) => {
  try {
    const policies = await installmentPolicyService.list((req as any).user.companyId);
    res.json({ success: true, data: policies });
  } catch (error: any) {
    next(error);
  }
});

router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'));

router.post('/', auditLog(AuditAction.CREATE, 'InstallmentPolicy'), async (req, res) => {
  try {
    const companyId = (req as any).user.companyId;
    const { branchId, paymentMethod, maxInstallments, interestFreeInstallments } = req.body;
    if (!paymentMethod || maxInstallments === undefined) {
      return res.status(400).json({ success: false, error: 'paymentMethod e maxInstallments são obrigatórios' });
    }
    const policy = await installmentPolicyService.create({
      companyId,
      branchId,
      paymentMethod,
      maxInstallments: Number(maxInstallments),
      interestFreeInstallments: interestFreeInstallments !== undefined ? Number(interestFreeInstallments) : 1,
    });
    return res.status(201).json({ success: true, data: policy });
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

router.put('/:id', auditLog(AuditAction.UPDATE, 'InstallmentPolicy'), async (req, res) => {
  try {
    const companyId = (req as any).user.companyId;
    const { maxInstallments, interestFreeInstallments, isActive } = req.body;
    const policy = await installmentPolicyService.update(req.params.id, companyId, {
      maxInstallments: maxInstallments !== undefined ? Number(maxInstallments) : undefined,
      interestFreeInstallments: interestFreeInstallments !== undefined ? Number(interestFreeInstallments) : undefined,
      isActive,
    });
    return res.json({ success: true, data: policy });
  } catch (error: any) {
    if (error.message === 'Política de parcelamento não encontrada') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return res.status(400).json({ success: false, error: error.message });
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'InstallmentPolicy'), async (req, res, next) => {
  try {
    await installmentPolicyService.delete(req.params.id, (req as any).user.companyId);
    res.json({ success: true, message: 'Política excluída com sucesso' });
  } catch (error: any) {
    if (error.message === 'Política de parcelamento não encontrada') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

export default router;
