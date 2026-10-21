import { Router, Request, Response, NextFunction } from 'express';
import moduleSettingsService, { SYSTEM_MODULES } from '../services/module-settings.service';
import { authMiddleware } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireUserType } from '../middleware/permission';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);

// Empresa alvo. Só SUPER_ADMIN (JWT sem empresa) escolhe — por ?companyId ou
// no body; os demais SEMPRE usam a do token, ignorando o que vier do cliente.
// Antes as rotas usavam `user.companyId` direto: para o SUPER_ADMIN era
// `undefined`, o Prisma ignora `undefined` no where e a alteração caía na
// primeira linha daquele módulo de QUALQUER empresa.
function resolveCompanyId(req: Request): string | undefined {
  const user = (req as any).user;
  if (user.userType === 'SUPER_ADMIN') {
    const requested = (req.query.companyId as string | undefined) || (req.body?.companyId as string | undefined);
    return requested || undefined;
  }
  return user.companyId;
}

// Estado EFETIVO (só habilitado/desativado + a origem da configuração) é
// aberto a qualquer usuário autenticado do tenant, propositalmente — a
// Sidebar (e qualquer tela) precisa saber quais módulos estão ligados
// para TODO mundo, não só para quem administra. Não é informação
// sensível (diferente do histórico abaixo, que expõe quem desativou e
// por quê). RLS/tenantIsolation já impedem ver módulos de outra empresa.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const companyId = resolveCompanyId(req);
    // O gate (requireModuleEnabled) decide pela filial do TOKEN. O menu precisa ver o
    // mesmo estado: quem opera numa filial recebe o efetivo da própria filial (antes o
    // GET sem ?branchId devolvia só o company-wide e o menu mostrava um módulo que o
    // admin desligou só para aquela filial). Só admin pode inspecionar outra via ?branchId.
    const isAdmin = user.userType === 'SUPER_ADMIN' || user.userType === 'COMPANY_ADMIN';
    const requestedBranchId = req.query.branchId as string | undefined;
    const branchId = (isAdmin ? requestedBranchId || user.branchId : user.branchId) || undefined;
    const effective = await moduleSettingsService.listEffective(companyId, branchId);
    res.json({ modules: effective });
  } catch (error) {
    next(error);
  }
});

// Ativar/desativar módulo, e ver o histórico de quem fez isso, é uma
// decisão/informação administrativa da empresa — mesmo nível de acesso já
// usado para gerenciar usuários/perfis.
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'));

// Histórico cru (quem desativou/reativou, quando, por quê) — auditoria.
router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: 'companyId é obrigatório para SUPER_ADMIN' });
    }
    const history = await moduleSettingsService.listRaw(companyId);
    return res.json({ history });
  } catch (error) {
    return next(error);
  }
});

// A resposta é a linha crua (sem `data`), então o audit é descrito aqui: módulo,
// estado, filial e o MOTIVO (a linha só guarda o último motivo — o audit
// preserva cada mudança).
router.post(
  '/:module',
  auditLog(AuditAction.UPDATE, 'CompanyModuleSetting', {
    describe: (req, body) => ({
      entityId: body?.id ?? null,
      companyId: body?.companyId ?? null,
      newValue: {
        module: req.params.module,
        branchId: body?.branchId ?? null,
        isEnabled: body?.isEnabled,
        reason: req.body?.reason ?? null,
      },
    }),
  }),
  async (req: Request, res: Response) => {
  try {
    const { module } = req.params;
    const { isEnabled, branchId, reason } = req.body;
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: 'companyId é obrigatório para SUPER_ADMIN' });
    }

    if (!SYSTEM_MODULES.includes(module as any)) {
      return res.status(400).json({ error: `Unknown module: ${module}` });
    }
    if (typeof isEnabled !== 'boolean') {
      return res.status(400).json({ error: 'isEnabled (boolean) is required' });
    }
    if (isEnabled === false && (!reason || typeof reason !== 'string' || reason.trim().length < 3)) {
      return res.status(400).json({ error: 'reason is required to disable a module (minimum 3 characters)' });
    }

    const result = await moduleSettingsService.setEnabled({
      companyId,
      branchId: branchId || null,
      module: module as any,
      isEnabled,
      actorId: (req as any).user.userId,
      reason,
    });

    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
  }
);

export default router;
