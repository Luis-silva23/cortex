import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { rateLimitGeneral } from '../middlewares/advancedRateLimit';
import observabilityService from '../services/observability.service';

/**
 * Observabilidade da plataforma (Super ADM TI apenas) — métricas de
 * requisição, saúde de infraestrutura, jobs, logs técnicos. Consome
 * RequestLog/SystemLog (packages/database/prisma/schema.prisma) e o estado
 * ao vivo das filas BullMQ (config/queue.ts). Escopo de PLATAFORMA, não de
 * empresa — por isso `requireSuperAdmin` em todo o router.
 */

const router = Router();

// tenantIsolation popula app.user_type='SUPER_ADMIN' no contexto de RLS —
// sem ela as queries a RequestLog/SystemLog eram negadas por padrão.
router.use(authMiddleware, requireSuperAdmin, tenantIsolation, rateLimitGeneral);

function parsePage(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// ---------- 1. Métricas de requisição ----------

router.get('/metrics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await observabilityService.getMetrics({
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      route: (req.query.route as string) || undefined,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 2. Estado das filas (BullMQ, ao vivo) ----------

router.get('/jobs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await observabilityService.getJobsStatus();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 3. Health check detalhado ----------

router.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await observabilityService.getDetailedHealth();
    const statusCode = result.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 4. Segurança ----------

router.get('/security', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await observabilityService.getSecurityStats({
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 5. Integrações (TEF/PIX + Fiscal) ----------

router.get('/integrations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await observabilityService.getIntegrationStats({
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 6. Logs ----------

router.get('/logs/system/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await observabilityService.getSystemLogById(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'System log not found' });
    }
    return res.json(row);
  } catch (error) {
    return next(error);
  }
});

router.get('/logs/system', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await observabilityService.listSystemLogs({
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      level: req.query.level as string,
      category: req.query.category as string,
      service: req.query.service as string,
      event: req.query.event as string,
      requestId: req.query.requestId as string,
      userId: req.query.userId as string,
      companyId: req.query.companyId as string,
      branchId: req.query.branchId as string,
      device: req.query.device as string,
      page: parsePage(req.query.page),
      limit: parsePage(req.query.limit),
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/logs/requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // statusCode não numérico virava NaN no Prisma (500 "Erro interno").
    const statusCode = req.query.statusCode ? Number(req.query.statusCode) : undefined;
    if (statusCode !== undefined && !Number.isInteger(statusCode)) {
      return res.status(400).json({ success: false, error: 'Filtro "statusCode" deve ser um número (ex.: 500)' });
    }
    const result = await observabilityService.listRequestLogs({
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      route: req.query.route as string,
      statusCode,
      method: req.query.method as string,
      requestId: req.query.requestId as string,
      companyId: req.query.companyId as string,
      branchId: req.query.branchId as string,
      userId: req.query.userId as string,
      device: req.query.device as string,
      page: parsePage(req.query.page),
      limit: parsePage(req.query.limit),
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

// ---------- 7. Alertas ----------

router.get('/alerts', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await observabilityService.getAlerts();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
