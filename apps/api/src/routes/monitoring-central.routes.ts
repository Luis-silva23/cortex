import { Router, Request, Response, NextFunction } from 'express';
import { AuditAction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { rateLimitGeneral } from '../middlewares/advancedRateLimit';
import { RANGES, type RangeKey } from '../services/monitoring.service';
import { ALL_MODULES, companyDetail, getOverview, getSeries, isRange, listCompanies } from '../services/monitoring-central/overview.service';
import { ACTIONS, getAlert, listAlerts, listAssignees, transition } from '../services/monitoring-central/alert-center.service';
import { createLead, getFunnel, linkCompany, listLeads, moveLead } from '../services/monitoring-central/funnel.service';
import { externalStatus } from '../services/monitoring-central/external-status.service';
import { checkResendDomain } from '../services/monitoring-central/resend.service';
import { getEffective, updateOverrides } from '../services/monitoring-central/settings.service';
import { ALL_STAGES, type AlertAction, type AlertCategory, type AlertStatus, type CompanyLifecycle } from '../services/monitoring-central/model';

/**
 * CENTRAL DE MONITORAMENTO (Super Admin, escopo de PLATAFORMA): `/api/monitoring/central/*`. Montada ANTES de `/monitoring` (ver routes/index.ts). TODAS as rotas exigem
 * SUPER_ADMIN no backend (nenhum papel de empresa — administrador, gerente, operador — chega aqui, nem por filtro, agregação ou exportação) e têm limite de requisições.
 * Os parâmetros são validados por lista fechada; id de empresa precisa ser UUID. Nenhuma resposta traz segredo.
 */
const router = Router();
router.use(authMiddleware, requireSuperAdmin, tenantIsolation, rateLimitGeneral);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const intOf = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const rangeOf = (v: unknown): RangeKey => (isRange(v) ? v : '24h');
const uuidParam = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError(`${what} inválido.`, 400, 'INVALID_ID');
  return v;
};
const user = (req: Request) => (req as Request & { user: { userId: string } }).user;

// ---------- Visão executiva e séries ----------
router.get('/overview', wrap(async (req, res) => res.json(await getOverview(rangeOf(req.query.range)))));
router.get('/series', wrap(async (req, res) => res.json(await getSeries(rangeOf(req.query.range)))));
router.get('/meta', wrap(async (_req, res) => res.json({ ranges: Object.keys(RANGES), modules: ALL_MODULES, stages: ALL_STAGES })));

// ---------- Empresas ----------
router.get('/companies', wrap(async (req, res) => {
  const lifecycle = str(req.query.lifecycle);
  if (lifecycle && !['ACTIVE', 'ONBOARDING', 'SUSPENDED'].includes(lifecycle)) throw new AppError('Situação inválida.', 400, 'INVALID_FILTER');
  const severity = str(req.query.severity);
  if (severity && !['ANY', 'ATTENTION', 'CRITICAL', 'OFFLINE'].includes(severity)) throw new AppError('Gravidade inválida.', 400, 'INVALID_FILTER');
  const dir = str(req.query.dir);
  res.json(
    await listCompanies({
      range: rangeOf(req.query.range),
      q: str(req.query.q),
      lifecycle: lifecycle as CompanyLifecycle | undefined,
      severity,
      sort: str(req.query.sort),
      dir: dir === 'desc' ? 'desc' : 'asc',
      page: intOf(req.query.page),
      limit: intOf(req.query.limit),
    })
  );
}));

router.get('/companies/:companyId', wrap(async (req, res) => {
  const companyId = uuidParam(req.params.companyId, 'Empresa');
  const module = str(req.query.module);
  if (module && !ALL_MODULES.includes(module)) throw new AppError('Módulo inválido.', 400, 'INVALID_FILTER');
  const severity = str(req.query.severity);
  if (severity && !['ANY', 'ATTENTION', 'CRITICAL', 'OFFLINE'].includes(severity)) throw new AppError('Gravidade inválida.', 400, 'INVALID_FILTER');
  const detail = await companyDetail(companyId, { range: rangeOf(req.query.range), module, severity });
  if (!detail) throw new AppError('Empresa não encontrada.', 404, 'COMPANY_NOT_FOUND');
  res.json(detail);
}));

// ---------- Central de alertas (tratamento) ----------
router.get('/alert-center/assignees', wrap(async (_req, res) => res.json({ assignees: await listAssignees() })));
router.get('/alert-center', wrap(async (req, res) => {
  const status = str(req.query.status);
  if (status && !['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED'].includes(status)) throw new AppError('Estado inválido.', 400, 'INVALID_FILTER');
  const scope = str(req.query.scope);
  if (scope && !['central', 'company'].includes(scope)) throw new AppError('Escopo inválido.', 400, 'INVALID_FILTER');
  const companyId = str(req.query.companyId);
  if (companyId) uuidParam(companyId, 'Empresa');
  res.json(
    await listAlerts({
      status: status as AlertStatus | undefined,
      severity: str(req.query.severity),
      category: str(req.query.category) as AlertCategory | undefined,
      companyId,
      scope: scope as 'central' | 'company' | undefined,
      q: str(req.query.q),
      page: intOf(req.query.page),
      limit: intOf(req.query.limit),
    })
  );
}));
router.get('/alert-center/:id', wrap(async (req, res) => res.json(await getAlert(uuidParam(req.params.id, 'Alerta')))));
router.post(
  '/alert-center/:id/actions',
  auditLog(AuditAction.UPDATE, 'MonitoringAlert', { describe: (req, body) => ({ entityId: req.params.id, newValue: { action: req.body?.action, status: body?.status ?? null } }) }),
  wrap(async (req, res) => {
    const id = uuidParam(req.params.id, 'Alerta');
    const action = str(req.body?.action) as AlertAction | undefined;
    if (!action || !ACTIONS.includes(action)) throw new AppError('Ação inválida.', 400, 'INVALID_ALERT_ACTION');
    const assignee = req.body?.assigneeId === null ? null : str(req.body?.assigneeId);
    if (assignee) uuidParam(assignee, 'Responsável');
    res.json(await transition(id, user(req).userId, { action, note: typeof req.body?.note === 'string' ? req.body.note : undefined, assigneeId: assignee }));
  })
);

// ---------- Funil comercial ----------
router.get('/funnel', wrap(async (_req, res) => res.json(await getFunnel())));
router.get('/funnel/leads', wrap(async (req, res) => res.json(await listLeads({ stage: str(req.query.stage), q: str(req.query.q), page: intOf(req.query.page), limit: intOf(req.query.limit) }))));
router.post(
  '/funnel/leads',
  auditLog(AuditAction.CREATE, 'CommercialLead', { describe: (_req, body) => ({ entityId: body?.id, newValue: { stage: body?.stage } }) }),
  wrap(async (req, res) => res.status(201).json(await createLead(req.body ?? {}, user(req).userId)))
);
router.post(
  '/funnel/leads/:id/move',
  auditLog(AuditAction.UPDATE, 'CommercialLead', { describe: (req, body) => ({ entityId: req.params.id, newValue: { toStage: body?.stage } }) }),
  wrap(async (req, res) => res.json(await moveLead(uuidParam(req.params.id, 'Oportunidade'), req.body?.stage, user(req).userId, req.body?.note)))
);
router.post(
  '/funnel/leads/:id/link-company',
  auditLog(AuditAction.UPDATE, 'CommercialLead', { describe: (req, body) => ({ entityId: req.params.id, newValue: { companyId: body?.companyId ?? null } }) }),
  wrap(async (req, res) => res.json(await linkCompany(uuidParam(req.params.id, 'Oportunidade'), req.body?.companyId, user(req).userId)))
);

// ---------- Serviços externos, limites e custos ----------
router.get('/external', wrap(async (_req, res) => res.json(await externalStatus())));
// Verificação OPCIONAL e somente-leitura do domínio remetente no provedor (não envia e-mail, sem custo): só por ação explícita.
router.post('/external/resend/check', wrap(async (_req, res) => res.json(await checkResendDomain())));
router.get('/settings', wrap(async (_req, res) => {
  const e = await getEffective();
  res.json({ toggles: e.toggles, limits: e.limits, envCeilings: e.env, overridden: e.overridden });
}));
router.put(
  '/settings',
  auditLog(AuditAction.UPDATE, 'MonitoringSetting', { describe: (req) => ({ entityId: 'config', newValue: { toggles: req.body?.toggles, limits: req.body?.limits } }) }),
  wrap(async (req, res) => {
    const e = await updateOverrides(req.body, user(req).userId);
    res.json({ toggles: e.toggles, limits: e.limits, envCeilings: e.env, overridden: e.overridden });
  })
);

export default router;
