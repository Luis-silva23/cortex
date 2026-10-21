import { Router } from 'express';
import roleService from '../services/role.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

/**
 * Administração do RBAC granular (Role/Permission/RolePermission) — ver
 * role.service.ts para o histórico de por que isto não existia até a
 * FASE 31. Atribuição de perfil a usuário (UserRole) fica em user.routes.ts
 * por ser mais natural sob /users/:id/roles.
 */

const router = Router();

router.use(authMiddleware, tenantIsolation);

function scopeCompanyId(req: any): string | undefined {
  return req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
}

// Só Super Admin e Company Admin administram perfis/permissões.
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'));

router.get('/', async (req, res, next) => {
  try {
    const roles = await roleService.listRoles(scopeCompanyId(req));
    res.json({ success: true, data: roles });
  } catch (error: any) {
    next(error);
  }
});

router.post('/', auditLog(AuditAction.CREATE, 'Role'), async (req, res, next) => {
  try {
    const user = req.user!;
    const { name, description, companyId } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'name é obrigatório' });
    }

    // Super Admin pode criar perfil de sistema (companyId null) explicitamente
    // passando companyId: null; qualquer outro valor é ignorado e forçado
    // para a própria empresa quando não for Super Admin.
    const targetCompanyId = user.userType === 'SUPER_ADMIN' ? (companyId ?? null) : user.companyId;
    const role = await roleService.createRole({ name, description, companyId: targetCompanyId ?? null });
    return res.status(201).json({ success: true, data: role });
  } catch (error: any) {
    return next(error);
  }
});

router.put('/:id', auditLog(AuditAction.UPDATE, 'Role'), async (req, res, next) => {
  try {
    const { name, description } = req.body;
    const role = await roleService.updateRole(req.params.id, { name, description }, scopeCompanyId(req));
    res.json({ success: true, data: role });
  } catch (error: any) {
    if (error.message === 'Perfil não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'Role'), async (req, res, next) => {
  try {
    await roleService.deleteRole(req.params.id, scopeCompanyId(req));
    res.json({ success: true, message: 'Perfil excluído com sucesso' });
  } catch (error: any) {
    if (error.message === 'Perfil não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

router.post('/:id/permissions',
  auditLog(AuditAction.PERMISSION_CHANGED, 'Role', {
    describe: (req) => ({ entityId: req.params.id, newValue: { operation: 'PERMISSION_GRANTED_TO_ROLE', roleId: req.params.id, permissionId: req.body?.permissionId ?? null } }),
  }),
  async (req, res, next) => {
  try {
    const { permissionId } = req.body;
    if (!permissionId) {
      return res.status(400).json({ success: false, error: 'permissionId é obrigatório' });
    }
    await roleService.assignPermission(req.params.id, permissionId, scopeCompanyId(req));
    return res.status(201).json({ success: true });
  } catch (error: any) {
    if (error.message === 'Perfil não encontrado' || error.message === 'Permissão não encontrada') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

router.delete('/:id/permissions/:permissionId',
  auditLog(AuditAction.PERMISSION_CHANGED, 'Role', {
    describe: (req) => ({ entityId: req.params.id, newValue: { operation: 'PERMISSION_REVOKED_FROM_ROLE', roleId: req.params.id, permissionId: req.params.permissionId } }),
  }),
  async (req, res, next) => {
  try {
    await roleService.revokePermission(req.params.id, req.params.permissionId, scopeCompanyId(req));
    return res.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Perfil não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

export default router;
