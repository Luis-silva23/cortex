import { Router } from 'express';
import { LicenseService } from '../services/license.service';
import { createLicenseSchema, approveLicenseSchema } from '@ln-system/shared/validators';
import { validateData } from '@ln-system/shared/utils/validation';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import type { LicenseType } from '@ln-system/shared/types';

const router = Router();
const licenseService = new LicenseService();

// Todas as rotas requerem autenticação. `tenantIsolation` popula o
// contexto de RLS (empresa do usuário, ou bypass total para SUPER_ADMIN) —
// sem ela toda query a `licenses` era negada por padrão pelas policies.
router.use(authMiddleware, tenantIsolation);

/**
 * GET /api/licenses
 * Listar licenças (Super Admin vê todas, outros veem apenas da empresa)
 */
router.get('/', async (req, res, next) => {
  try {
    const user = req.user!;
    
    let licenses;
    if (user.userType === 'SUPER_ADMIN') {
      licenses = await licenseService.findAll();
    } else if (user.companyId) {
      licenses = await licenseService.findByCompany(user.companyId);
    } else {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }

    return res.json({ success: true, data: licenses });
  } catch (error: any) {
    return next(error);
  }
});

/**
 * GET /api/licenses/:id
 * Buscar licença por ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const license = await licenseService.findById(req.params.id);
    
    if (!license) {
      return res.status(404).json({ success: false, error: 'Licença não encontrada' });
    }

    // Validar acesso
    const user = req.user!;
    if (user.userType !== 'SUPER_ADMIN' && license.companyId !== user.companyId) {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }

    return res.json({ success: true, data: license });
  } catch (error: any) {
    return next(error);
  }
});

/**
 * POST /api/licenses
 * Criar licença (apenas Super Admin)
 */
router.post('/', requireSuperAdmin, auditLog(AuditAction.CREATE, 'License'), async (req, res, next) => {
  try {
    const data = validateData(createLicenseSchema, req.body);
    const license = await licenseService.create({
      ...data,
      licenseType: data.licenseType as LicenseType,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
    });
    res.status(201).json({ success: true, data: license });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/licenses/:id/approve
 * Aprovar licença (apenas Super Admin)
 */
router.post('/:id/approve', requireSuperAdmin, auditLog(AuditAction.LICENSE_APPROVED, 'License'), async (req, res, next) => {
  try {
    const data = validateData(approveLicenseSchema, req.body);
    const license = await licenseService.approve(
      req.params.id,
      {
        ...data,
        startDate: new Date(data.startDate),
        expiryDate: new Date(data.expiryDate),
      },
      req.user!.userId
    );
    res.json({ success: true, data: license });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/licenses/:id/suspend
 * Suspender licença (apenas Super Admin)
 */
router.post('/:id/suspend', requireSuperAdmin, auditLog(AuditAction.LICENSE_SUSPENDED, 'License'), async (req, res, next) => {
  try {
    const license = await licenseService.suspend(req.params.id);
    res.json({ success: true, data: license });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/licenses/:id/reactivate
 * Reativar licença (apenas Super Admin)
 */
router.post('/:id/reactivate', requireSuperAdmin, auditLog(AuditAction.UPDATE, 'License'), async (req, res, next) => {
  try {
    const license = await licenseService.reactivate(req.params.id);
    res.json({ success: true, data: license });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/licenses/:id/cancel
 * Cancelar licença (apenas Super Admin)
 */
router.post('/:id/cancel', requireSuperAdmin, auditLog(AuditAction.UPDATE, 'License'), async (req, res, next) => {
  try {
    const license = await licenseService.cancel(req.params.id);
    res.json({ success: true, data: license });
  } catch (error: any) {
    next(error);
  }
});

export default router;
