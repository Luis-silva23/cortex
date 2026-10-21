import { Router, Request, Response, NextFunction } from 'express';
import { AppError } from '@ln-system/shared';
import { prisma } from '@ln-system/database';
import dashboardService from '../services/dashboard.service';
import dashboardManagementService, { type ManagementScope } from '../services/dashboard-management.service';
import { resolveDashboardPeriod } from '../utils/dashboard-period';
import { authMiddleware, requireUserType, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { authorizedBranchIds } from '../utils/branch-access';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Filial de um dashboard — a REGRA DE ACESSO por filial (docs/CORTEX/contracts/tenant-branch-scope.md):
 *  - acesso EMPRESARIAL (SUPER_ADMIN na empresa-alvo, COMPANY_ADMIN): consolida a empresa (sem `branchId`) ou escolhe UMA filial DA PRÓPRIA empresa
 *    (`branchId` de outra empresa ou inexistente → 404; nunca devolve zeros que pareçam dado);
 *  - GERENTE e demais papéis de filial: SÓ as filiais a que estão vinculados (a principal + `user_branches`, calculadas no servidor — decisão 153). Com UMA
 *    filial, sempre ela; com VÁRIAS, escolhe uma delas ou recebe o consolidado das suas. Pedir filial que não é dele (mesma empresa ou não) é 403
 *    `BRANCH_FORBIDDEN`, não um filtro silencioso; sem nenhuma filial vinculada não há o que consultar (403 `BRANCH_REQUIRED`).
 * A RLS do Postgres repete a regra (defesa em profundidade); esta é a camada que responde com erro claro e impede a consulta.
 */
async function scopedBranchId(req: Request): Promise<string | undefined> {
  const user = req.user!;
  const raw = req.query.branchId;
  const requested = typeof raw === 'string' && raw ? raw : undefined;
  if (requested && !UUID_RE.test(requested)) throw new AppError('branchId inválido', 400, 'INVALID_BRANCH');
  if (user.userType === 'SUPER_ADMIN' || user.userType === 'COMPANY_ADMIN') {
    if (!requested) return undefined;
    const branch = await prisma.branch.findFirst({ where: { id: requested, companyId: user.companyId as string }, select: { id: true } });
    if (!branch) throw new AppError('Filial não encontrada nesta empresa', 404, 'BRANCH_NOT_FOUND');
    return branch.id;
  }
  // Papéis de filial: as filiais AUTORIZADAS vêm dos vínculos gravados (tenantIsolation → req.user.branchIds), nunca do pedido.
  const allowed = authorizedBranchIds(user) ?? [];
  if (allowed.length === 0) throw new AppError('Seu usuário não está vinculado a uma filial', 403, 'BRANCH_REQUIRED');
  if (requested) {
    if (!allowed.includes(requested)) throw new AppError('Você só consulta as filiais às quais está vinculado', 403, 'BRANCH_FORBIDDEN');
    return requested;
  }
  // sem pedido: uma só filial = ela (filtro explícito, como sempre); várias = consolidado das autorizadas (a RLS limita ao conjunto assinado)
  return allowed.length === 1 ? allowed[0] : undefined;
}

// Dashboards de dinheiro e de gestão são de quem GERE: SUPER_ADMIN (numa empresa), COMPANY_ADMIN e MANAGER. OPERATOR e VIEWER só
// têm o dashboard do PDV (/pdv, o dia da própria filial) e MECHANIC só o da oficina: a tela já era assim, e agora a API também
// nega (antes entregava vendas, valor de estoque a custo e a visão consolidada a quem a tela escondia).
const MANAGEMENT_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'] as const;


/**
 * Período do painel: a REGRA ÚNICA (utils/dashboard-period.ts). Com `period` (today, 7d, 30d, month...) o intervalo é resolvido
 * aqui, em Brasília, igual para todas as consultas; sem `period` vale o par legado startDate/endDate (clientes antigos).
 */
function periodRange(req: Request): { startDate?: string; endDate?: string } {
  if (req.query.period === undefined) return { startDate: req.query.startDate as string, endDate: req.query.endDate as string };
  const p = resolveDashboardPeriod({ period: req.query.period, start: req.query.start, end: req.query.end });
  return { startDate: p.current.start.toISOString(), endDate: new Date(p.current.end.getTime() - 1).toISOString() };
}

// Gerente sempre vê a própria filial (403 se pedir outra); administrador pode escolher uma filial da empresa ou ver a empresa toda.
async function managementScope(req: Request): Promise<ManagementScope> {
  const user = req.user!;
  const companyId = user.companyId as string;
  if (!companyId) throw new AppError('companyId é obrigatório', 400, 'COMPANY_CONTEXT_REQUIRED');
  return { companyId, branchId: (await scopedBranchId(req)) ?? null };
}

// ---------- 0. GESTÃO (resumo e séries do painel gerencial; docs/CORTEX/DASHBOARD_GERENCIAL.md) ----------

router.get('/management/summary', requireModuleEnabled('VENDAS'), requireUserType(...MANAGEMENT_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await dashboardManagementService.summary(await managementScope(req), { period: req.query.period, start: req.query.start, end: req.query.end }));
  } catch (error) {
    next(error);
  }
});

router.get('/management/timeseries', requireModuleEnabled('VENDAS'), requireUserType(...MANAGEMENT_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await dashboardManagementService.timeseries(await managementScope(req), { period: req.query.period, start: req.query.start, end: req.query.end }));
  } catch (error) {
    next(error);
  }
});

// ---------- 1. VENDAS ----------

// Dashboards de dinheiro (vendas, valor de estoque a custo, caixas, visão CEO) não
// são do MECHANIC; só o da oficina (`/workshop`, contagens) fica aberto a ele.
router.get('/sales', requireModuleEnabled('VENDAS'), requireUserType(...MANAGEMENT_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const result = await dashboardService.getSalesDashboard(
      user.companyId as string,
      await scopedBranchId(req),
      periodRange(req).startDate,
      periodRange(req).endDate
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 2. FINANCEIRO (dado sensível: restrito) ----------

router.get(
  '/financial',
  requireModuleEnabled('FINANCEIRO'),
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const result = await dashboardService.getFinancialDashboard(
        user.companyId as string,
        await scopedBranchId(req),
        periodRange(req).startDate,
        periodRange(req).endDate
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ---------- 3. ESTOQUE ----------

router.get('/stock', requireModuleEnabled('ESTOQUE'), requireUserType(...MANAGEMENT_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const staleDays = req.query.staleDays ? parseInt(req.query.staleDays as string, 10) : 90;
    const result = await dashboardService.getStockDashboard(
      user.companyId as string,
      await scopedBranchId(req),
      staleDays
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 4. OFICINA ----------

router.get('/workshop', requireModuleEnabled('OFICINA'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const overdueDays = req.query.overdueDays ? parseInt(req.query.overdueDays as string, 10) : 7;
    const result = await dashboardService.getWorkshopDashboard(
      user.companyId as string,
      await scopedBranchId(req),
      periodRange(req).startDate,
      periodRange(req).endDate,
      overdueDays
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 5. PDV ----------

router.get('/pdv', requireModuleEnabled('VENDAS'), denyUserTypes('MECHANIC'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const branchId = (await scopedBranchId(req)) || user.branchId;
    if (!branchId) {
      return res.status(400).json({ success: false, error: 'branchId é obrigatório' });
    }
    const result = await dashboardService.getPdvDashboard(user.companyId as string, branchId);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

// ---------- 6. SUPER ADMIN ----------

router.get(
  '/super-admin',
  requireUserType('SUPER_ADMIN'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await dashboardService.getSuperAdminDashboard();
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ---------- 7. CEO (visão consolidada multi-filial) ----------

router.get('/ceo', requireUserType(...MANAGEMENT_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    // SUPER_ADMIN pode consultar qualquer empresa via ?companyId=; os demais
    // usuários só enxergam a própria empresa (ignora o parâmetro).
    const companyId =
      user.userType === 'SUPER_ADMIN' && req.query.companyId
        ? (req.query.companyId as string)
        : (user.companyId as string);

    if (!companyId) {
      return res.status(400).json({ success: false, error: 'companyId é obrigatório' });
    }

    const result = await dashboardService.getCeoDashboard(
      companyId,
      periodRange(req).startDate,
      periodRange(req).endDate
    );
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

export default router;
