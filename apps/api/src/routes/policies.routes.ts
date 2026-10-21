import { canAccessBranch } from '../utils/branch-access';
import { Router, Request, Response, NextFunction } from 'express';
import { AppError, AuthorizationError } from '@ln-system/shared';
import { AuditAction, prisma } from '@ln-system/database';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { policyService } from '../services/policy.service';

/**
 * Políticas por empresa/filial (docs/CORTEX/POLICIES.md).
 *  GET  /policies/effective?branchId=  — valores efetivos (qualquer usuário da empresa; usuário de filial só a própria)
 *  GET  /policies?branchId=            — catálogo + valores (gerência+)
 *  GET  /policies/history              — histórico de alterações (gerência+)
 *  PUT  /policies/:key                 — { value, branchId?, reason } (administração)
 *  DELETE /policies/:key?branchId=     — { reason } volta ao padrão/ao valor da empresa (administração)
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);

/** Filial consultada: usuário preso a uma filial só lê a dele; a administração escolhe uma filial da própria empresa. */
export async function readableBranchId(req: Request): Promise<string | null> {
  const user = (req as any).user;
  const requested = (req.query.branchId as string | undefined) || null;
  if (user.branchId) {
    if (requested && requested !== user.branchId && !canAccessBranch(user, requested)) throw new AuthorizationError('Você só pode consultar as filiais às quais está vinculado', 'BRANCH_FORBIDDEN');
    return requested || user.branchId;
  }
  if (!requested) return null;
  const branch = await prisma.branch.findFirst({ where: { id: requested, companyId: user.companyId }, select: { id: true } });
  if (!branch) throw new AppError('Filial não encontrada nesta empresa', 400, 'BRANCH_NOT_FOUND');
  return branch.id;
}

export function companyIdOf(req: Request): string {
  const companyId = (req as any).user?.companyId;
  if (!companyId) throw new AppError('Empresa não identificada', 400, 'COMPANY_CONTEXT_REQUIRED');
  return companyId;
}

router.get('/effective', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = companyIdOf(req);
    const branchId = await readableBranchId(req);
    const { values, sources } = await policyService.resolve(companyId, branchId);
    return res.json({ branchId, values, sources });
  } catch (error) {
    return next(error);
  }
});

router.get('/', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = companyIdOf(req);
    const branchId = await readableBranchId(req);
    return res.json({ branchId, policies: await policyService.describe(companyId, branchId) });
  } catch (error) {
    return next(error);
  }
});

router.get('/history', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = companyIdOf(req);
    const user = (req as any).user;
    const branchFilter = user.branchId ? user.branchId : req.query.branchId === 'company' ? null : (req.query.branchId as string | undefined);
    const changes = await policyService.history(companyId, {
      key: (req.query.key as string) || undefined,
      branchId: branchFilter,
      limit: Number(req.query.limit) || 50,
    });
    return res.json({ changes });
  } catch (error) {
    return next(error);
  }
});

router.put(
  '/:key',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Policy', {
    describe: (req, body) => ({
      entityId: req.params.key,
      newValue: {
        politica: req.params.key,
        filial: body?.branchId ?? null,
        antes: body?.oldValue ?? null,
        depois: body?.value ?? null,
        motivo: req.body?.reason ?? null,
        alterou: body?.changed ?? null,
      },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await policyService.set({
        companyId: companyIdOf(req),
        branchId: req.body?.branchId ?? null,
        key: req.params.key,
        value: req.body?.value,
        reason: req.body?.reason,
        userId: (req as any).user.userId,
      });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  }
);

router.delete(
  '/:key',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Policy', {
    describe: (req, body) => ({
      entityId: req.params.key,
      newValue: { politica: req.params.key, filial: body?.branchId ?? null, antes: body?.oldValue ?? null, depois: 'padrão', motivo: req.body?.reason ?? null },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await policyService.reset({
        companyId: companyIdOf(req),
        branchId: (req.query.branchId as string) || req.body?.branchId || null,
        key: req.params.key,
        reason: req.body?.reason,
        userId: (req as any).user.userId,
      });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
