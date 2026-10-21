import { Router } from 'express';
import branchService from '../services/branch.service';
import { createBranchSchema, updateBranchSchema } from '@ln-system/shared/validators';
import { validateData } from '@ln-system/shared/utils/validation';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction, prisma } from '@ln-system/database';

/**
 * Filial (Branch) — antes desta rota, o modelo existia no schema e era
 * referenciado como FK por quase toda tabela de negócio (Sale, ServiceOrder,
 * StockMovement, etc), mas não havia nenhuma forma de criar/gerenciar uma
 * filial pela API. Uma empresa com mais de uma unidade não tinha como
 * operar. Segue o mesmo padrão de license.routes.ts: Super Admin enxerga/
 * gerencia filiais de qualquer empresa; Company Admin/Manager só da própria.
 */

const router = Router();

// `tenantIsolation` popula o contexto de RLS (empresa do usuário, ou
// bypass total para SUPER_ADMIN) — sem ela toda query a `branches` era
// negada por padrão pelas policies.
router.use(authMiddleware, tenantIsolation);

function resolveCompanyId(req: any): string | undefined {
  const user = req.user!;
  if (user.userType === 'SUPER_ADMIN') {
    return (req.query.companyId as string) || (req.body?.companyId as string) || undefined;
  }
  return user.companyId;
}

/**
 * GET /api/branches
 * Super Admin: todas as filiais, ou filtradas por ?companyId=
 * Demais: apenas filiais da própria empresa
 */
router.get('/', async (req, res, next) => {
  try {
    const user = req.user!;
    const companyId = resolveCompanyId(req);

    if (user.userType !== 'SUPER_ADMIN' && !companyId) {
      return res.status(403).json({ success: false, error: 'Usuário não associado a uma empresa' });
    }

    if (!companyId) {
      // Super Admin sem filtro: lista de todas as empresas.
      const branches = await prisma.branch.findMany({
        orderBy: [{ companyId: 'asc' }, { isHeadquarter: 'desc' }, { createdAt: 'asc' }],
        include: { company: { select: { id: true, name: true } } },
      });
      return res.json({ success: true, data: branches });
    }

    const branches = await branchService.findByCompany(companyId);
    return res.json({ success: true, data: branches });
  } catch (error: any) {
    return next(error);
  }
});

/**
 * GET /api/branches/:id
 */
router.get('/:id', async (req, res, next) => {
  try {
    const user = req.user!;
    const companyId = user.userType === 'SUPER_ADMIN' ? undefined : user.companyId;
    const branch = await branchService.findById(req.params.id, companyId);

    if (!branch) {
      return res.status(404).json({ success: false, error: 'Filial não encontrada' });
    }

    return res.json({ success: true, data: branch });
  } catch (error: any) {
    return next(error);
  }
});

/**
 * POST /api/branches
 * Super Admin ou Company Admin.
 */
router.post(
  '/',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.CREATE, 'Branch'),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const data = validateData(createBranchSchema, req.body);

      const companyId = user.userType === 'SUPER_ADMIN' ? data.companyId : user.companyId;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          error: user.userType === 'SUPER_ADMIN' ? 'companyId é obrigatório' : 'Usuário não associado a uma empresa',
        });
      }

      const branch = await branchService.create({ ...data, companyId });
      return res.status(201).json({ success: true, data: branch });
    } catch (error: any) {
      return next(error);
    }
  }
);

/**
 * PUT /api/branches/:id
 */
router.put(
  '/:id',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Branch'),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const data = validateData(updateBranchSchema, req.body);
      const companyId = user.userType === 'SUPER_ADMIN' ? undefined : user.companyId;

      const branch = await branchService.update(req.params.id, data, companyId);
      return res.json({ success: true, data: branch });
    } catch (error: any) {
      return next(error);
    }
  }
);

/**
 * POST /api/branches/:id/toggle-active
 */
router.post(
  '/:id/toggle-active',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Branch'),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const companyId = user.userType === 'SUPER_ADMIN' ? undefined : user.companyId;
      const branch = await branchService.toggleActive(req.params.id, companyId);
      return res.json({ success: true, data: branch });
    } catch (error: any) {
      return next(error);
    }
  }
);

/**
 * DELETE /api/branches/:id
 */
router.delete(
  '/:id',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.DELETE, 'Branch'),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const companyId = user.userType === 'SUPER_ADMIN' ? undefined : user.companyId;
      await branchService.delete(req.params.id, companyId);
      return res.json({ success: true, message: 'Filial excluída com sucesso' });
    } catch (error: any) {
      return next(error);
    }
  }
);

export default router;
