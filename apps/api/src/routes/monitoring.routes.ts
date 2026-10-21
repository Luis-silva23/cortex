import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@ln-system/database';
import monitoringService, { RANGES, RangeKey } from '../services/monitoring.service';
import monitoringThresholds from '../services/monitoring-thresholds.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();
router.use(authMiddleware, tenantIsolation);

// SUPER_ADMIN vê qualquer empresa; COMPANY_ADMIN só a própria; demais papéis não acessam o monitoramento.
function canSee(req: Request, companyId: string) {
  const user = (req as any).user;
  return user.userType === 'SUPER_ADMIN' || (user.userType === 'COMPANY_ADMIN' && user.companyId === companyId);
}

router.use('/companies/:companyId', (req: Request, res: Response, next: NextFunction) => {
  if (!canSee(req, req.params.companyId)) return res.status(403).json({ error: 'Acesso negado' });
  return next();
});

async function branchOf(req: Request, res: Response) {
  const branch = await prisma.branch.findFirst({ where: { id: req.params.branchId, companyId: req.params.companyId }, select: { id: true, name: true } });
  if (!branch) res.status(404).json({ error: 'Filial não encontrada nesta empresa' });
  return branch;
}

const rangeOf = (req: Request): RangeKey => ((req.query.range as string) in RANGES ? (req.query.range as RangeKey) : '24h');

router.get('/companies/:companyId/health', async (req, res, next) => {
  try {
    const health = await monitoringService.companyHealth(req.params.companyId);
    if (!health) return res.status(404).json({ error: 'Empresa não encontrada' });
    return res.json(health);
  } catch (error) {
    return next(error);
  }
});

router.get('/companies/:companyId/branches/:branchId/health', async (req, res, next) => {
  try {
    const branch = await branchOf(req, res);
    if (!branch) return undefined;
    return res.json({ branch, ...(await monitoringService.branchHealth(req.params.companyId, branch.id)) });
  } catch (error) {
    return next(error);
  }
});

router.get('/companies/:companyId/branches/:branchId/series', async (req, res, next) => {
  try {
    const branch = await branchOf(req, res);
    if (!branch) return undefined;
    return res.json(await monitoringService.series(req.params.companyId, branch.id, rangeOf(req)));
  } catch (error) {
    return next(error);
  }
});

router.get('/companies/:companyId/branches/:branchId/endpoints', async (req, res, next) => {
  try {
    const branch = await branchOf(req, res);
    if (!branch) return undefined;
    return res.json({ range: rangeOf(req), endpoints: await monitoringService.endpoints(req.params.companyId, branch.id, rangeOf(req)) });
  } catch (error) {
    return next(error);
  }
});

router.get('/companies/:companyId/incidents', async (req, res, next) => {
  try {
    const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
    return res.json({ incidents: await monitoringService.incidents(req.params.companyId, branchId, Number(req.query.limit) || 50) });
  } catch (error) {
    return next(error);
  }
});

router.get('/companies/:companyId/alerts', async (req, res, next) => {
  try {
    const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
    const alerts = await monitoringService.alerts({ companyId: req.params.companyId, branchId, open: req.query.open === 'true', limit: Number(req.query.limit) || 100 });
    return res.json({ alerts });
  } catch (error) {
    return next(error);
  }
});

// Alertas da infraestrutura central (banco, cache, filas, jobs): só SUPER_ADMIN.
router.get('/central/alerts', requireUserType('SUPER_ADMIN'), async (req, res, next) => {
  try {
    return res.json({ alerts: await monitoringService.alerts({ companyId: null, open: req.query.open === 'true', limit: Number(req.query.limit) || 100 }) });
  } catch (error) {
    return next(error);
  }
});

// ---------- Limites (thresholds) ----------
// Leitura: SUPER_ADMIN (qualquer escopo) e COMPANY_ADMIN (só a própria empresa). Escrita: só SUPER_ADMIN — além da
// trava aqui, a política RLS de monitoring_thresholds só aceita escrita de SUPER_ADMIN.
const scopeOf = (source: Record<string, unknown>) => ({
  companyId: typeof source.companyId === 'string' && source.companyId ? source.companyId : null,
  branchId: typeof source.branchId === 'string' && source.branchId ? source.branchId : null,
});

router.get('/thresholds', async (req, res, next) => {
  try {
    const user = (req as any).user;
    const scope = scopeOf(req.query);
    if (user.userType !== 'SUPER_ADMIN') {
      if (user.userType !== 'COMPANY_ADMIN') return res.status(403).json({ error: 'Acesso negado' });
      if (scope.companyId && scope.companyId !== user.companyId) return res.status(403).json({ error: 'Acesso negado' });
      scope.companyId = user.companyId;
    }
    return res.json({ scope, metrics: await monitoringThresholds.describe(scope.companyId, scope.branchId) });
  } catch (error) {
    return next(error);
  }
});

router.get('/thresholds/history', async (req, res, next) => {
  try {
    const user = (req as any).user;
    let { companyId } = scopeOf(req.query);
    if (user.userType !== 'SUPER_ADMIN') {
      if (user.userType !== 'COMPANY_ADMIN' || (companyId && companyId !== user.companyId)) return res.status(403).json({ error: 'Acesso negado' });
      companyId = user.companyId;
    }
    return res.json({ changes: await monitoringThresholds.history(companyId, Number(req.query.limit) || 100) });
  } catch (error) {
    return next(error);
  }
});

router.put('/thresholds', requireUserType('SUPER_ADMIN'), auditLog(AuditAction.UPDATE, 'MonitoringThreshold'), async (req, res, next) => {
  try {
    const { metric, attention, critical, reason } = req.body ?? {};
    const saved = await monitoringThresholds.set({ ...scopeOf(req.body ?? {}), metric, attention, critical, reason }, (req as any).user.userId);
    return res.json(saved);
  } catch (error) {
    return next(error);
  }
});

router.delete('/thresholds', requireUserType('SUPER_ADMIN'), auditLog(AuditAction.DELETE, 'MonitoringThreshold'), async (req, res, next) => {
  try {
    const { metric, reason } = req.body ?? {};
    return res.json(await monitoringThresholds.reset({ ...scopeOf(req.body ?? {}), metric, reason }, (req as any).user.userId));
  } catch (error) {
    return next(error);
  }
});

export default router;
