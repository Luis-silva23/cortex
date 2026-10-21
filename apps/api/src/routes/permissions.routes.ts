import { Router } from 'express';
import roleService from '../services/role.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware, tenantIsolation);
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'));

function scopeCompanyId(req: any): string | undefined {
  return req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
}

router.get('/', async (req, res, next) => {
  try {
    const permissions = await roleService.listPermissions(scopeCompanyId(req));
    res.json({ success: true, data: permissions });
  } catch (error: any) {
    next(error);
  }
});

router.post('/', auditLog(AuditAction.CREATE, 'Permission'), async (req, res, next) => {
  try {
    const user = req.user!;
    const { name, description, scope, companyId } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'name é obrigatório' });
    }

    const targetCompanyId = user.userType === 'SUPER_ADMIN' ? (companyId ?? null) : user.companyId;
    const permission = await roleService.createPermission({ name, description, scope, companyId: targetCompanyId ?? null });
    return res.status(201).json({ success: true, data: permission });
  } catch (error: any) {
    return next(error);
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'Permission'), async (req, res, next) => {
  try {
    await roleService.deletePermission(req.params.id, scopeCompanyId(req));
    res.json({ success: true, message: 'Permissão excluída com sucesso' });
  } catch (error: any) {
    if (error.message === 'Permissão não encontrada') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

export default router;
