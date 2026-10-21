import { Router, Request, Response } from 'express';
import { z } from 'zod';
import cashRegisterService from '../services/cash-register.service';
import { resolveListCompanyId } from '../utils/tenant-scope';
import {
  openCashRegisterSchema,
  closeCashRegisterSchema,
  cashMovementSchema,
  cashWithdrawalSchema,
  cashRegisterFilterSchema,
} from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, requireUserType, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { rateLimitAuthorizer } from '../middlewares/advancedRateLimit';
import { idempotency } from '../middleware/idempotency';
import { requireDeviceForCashOps } from '../middleware/device';
import { routeErrorMessage } from '../utils/route-error';
import { requireWriteBranchId } from '../utils/branch-context';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('VENDAS'));
// MECHANIC (oficina) não lê caixa (saldos, sangrias, fechamentos).
router.use(denyUserTypes('MECHANIC'));

// Buscar caixa atual aberto
router.get('/current', async (req: Request, res: Response) => {
  try {
    const { branchId } = req.query;
    const companyId = (req as any).user.companyId;
    const userId = (req as any).user.userId;

    if (!branchId) {
      return res.status(400).json({ error: 'branchId is required' });
    }

    const cashRegister = await cashRegisterService.getCurrentOpenRegister(
      companyId,
      branchId as string,
      userId
    );

    if (!cashRegister) {
      return res.status(404).json({ error: 'No open cash register found' });
    }

    return res.json(cashRegister);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Histórico de caixas
router.get('/history', async (req: Request, res: Response) => {
  try {
    const filters = cashRegisterFilterSchema.parse({
      ...req.query,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    });

    const result = await cashRegisterService.listCashRegisters({
      ...filters,
      companyId: resolveListCompanyId((req as any).user, filters.companyId),
    });

    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Buscar caixa por ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    const companyId = user.companyId;

    const cashRegister = await cashRegisterService.getCashRegisterById(id, companyId, {
      userType: user.userType,
      branchId: user.branchId,
    });

    if (!cashRegister) {
      return res.status(404).json({ error: 'Cash register not found' });
    }

    return res.json(cashRegister);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Pendências do caixa (pagamentos não confirmados, vendas em aberto) e se a política bloqueia o fechamento normal.
router.get('/:id/pendencies', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = await cashRegisterService.getPendencies(req.params.id, user.companyId, { userType: user.userType, branchId: user.branchId });
    return res.json(result);
  } catch (error: any) {
    return res.status(error.message === 'Cash register not found' ? 404 : error.statusCode ?? 400).json({ error: error.message });
  }
});

// Relatório de fechamento
router.get('/:id/closure-report', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    const companyId = user.companyId;

    const report = await cashRegisterService.getClosureReport(id, companyId, {
      userType: user.userType,
      branchId: user.branchId,
    });

    res.json(report);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA: nenhum write deste arquivo tinha trava de papel — o
// escopo de filial existe no service, mas VIEWER (só-leitura em todo o resto
// do sistema) conseguia abrir/fechar caixa e lançar reforço, e um MECHANIC
// idem. O único chamador real é o PDV (pdv-desktop/src/services/api.ts:
// open/close/movement/withdrawal), operado por OPERATOR/MANAGER e admins —
// nenhum frontend (admin-web/mobile/tv) escreve em caixa. Por isso aqui a
// trava é mais estreita que a dos módulos de cadastro: só quem opera o
// caixa. GETs (caixa atual, histórico, fechamento) continuam abertos.
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'));

// Abrir caixa
router.post('/open', requireDeviceForCashOps, idempotency(), auditLog(AuditAction.CREATE, 'CashRegister'), async (req: Request, res: Response) => {
  try {
    const data = openCashRegisterSchema.parse({
      ...req.body,
      companyId: (req as any).user.companyId,
      userId: (req as any).user.userId,
    });

    const cashRegister = await cashRegisterService.openCashRegister({
      ...data,
      branchId: await requireWriteBranchId((req as any).user, data.branchId),
      notes: data.notes ?? undefined,
    });

    res.status(201).json(cashRegister);
  } catch (error: any) {
    res.status(error.statusCode ?? 400).json({ error: routeErrorMessage(error, { fallback: 'Não foi possível abrir o caixa' }) });
  }
});

// Fechar caixa
router.post('/:id/close', requireDeviceForCashOps, idempotency(), auditLog(AuditAction.UPDATE, 'CashRegister'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;
    const data = closeCashRegisterSchema.parse(req.body);

    const cashRegister = await cashRegisterService.closeCashRegister(id, companyId, {
      ...data,
      notes: data.notes ?? undefined,
      closedBy: (req as any).user.userId,
      requesterUserType: (req as any).user.userType,
      requesterBranchId: (req as any).user.branchId,
    });

    res.json(cashRegister);
  } catch (error: any) {
    // 409 CASH_CLOSE_PENDING leva `details` (pendências e valores) para a tela oferecer o fechamento forçado.
    res.status(typeof error?.statusCode === 'number' ? error.statusCode : 400).json({
      error: error.message,
      ...(typeof error?.statusCode === 'number' && error.code ? { code: error.code } : {}),
      ...(error?.details ? { details: error.details } : {}),
    });
  }
});

// Fechamento FORÇADO (docs/CORTEX/policies/CAIXA.md): gerente/administrador (cash.forceCloseRoles), ou quem opera o
// caixa com as credenciais de um autorizador com esse perfil. Motivo obrigatório (mín. 10). Mesmo limitador da
// segunda autorização (valida senha/MFA de outra pessoa).
const forceCloseSchema = z.object({
  actualAmount: z.number().min(0).finite(),
  reason: z.string().max(1000),
  notes: z.string().max(1000).nullish(),
  declaredByMethod: z.record(z.number()).nullish(),
  differenceReason: z.string().max(1000).nullish(),
  authorizerNumericId: z.number().int().positive().nullish(),
  authorizerPassword: z.string().nullish(),
  authorizerMfaCode: z.string().nullish(),
});

router.post(
  '/:id/force-close',
  rateLimitAuthorizer,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'CashRegister', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        operacao: 'FECHAMENTO_FORCADO',
        motivo: body?.forcedReason ?? req.body?.reason ?? null,
        valorContado: body?.actualAmount ?? null,
        esperado: body?.expectedAmount ?? null,
        diferenca: body?.difference ?? null,
        autorizadoPor: body?.authorizer?.id ?? null,
        pendencias: body?.pendingSnapshot?.totals ?? null,
      },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const data = forceCloseSchema.parse(req.body ?? {});
      const result = await cashRegisterService.forceCloseCashRegister(req.params.id, user.companyId, {
        actualAmount: data.actualAmount,
        reason: data.reason,
        notes: data.notes ?? undefined,
        declaredByMethod: data.declaredByMethod ?? null,
        differenceReason: data.differenceReason ?? null,
        requester: { userId: user.userId, userType: user.userType, branchId: user.branchId },
        authorizerNumericId: data.authorizerNumericId,
        authorizerPassword: data.authorizerPassword,
        authorizerMfaCode: data.authorizerMfaCode,
        requestId: (req as any).requestId,
        device: req.headers['x-device-type'] as string | undefined,
      });
      return res.json(result);
    } catch (error: any) {
      return res.status(typeof error?.statusCode === 'number' ? error.statusCode : 400).json({
        error: routeErrorMessage(error, { fallback: 'Não foi possível fechar o caixa' }),
        ...(typeof error?.statusCode === 'number' && error.code ? { code: error.code } : {}),
        ...(error?.details ? { details: error.details } : {}),
      });
    }
  }
);

// Adicionar movimento (sangria/reforço)
// idempotency(): o PDV manda a mesma Idempotency-Key por reforço digitado — Enter repetido / reenvio após falta de
// resposta devolve o movimento já criado em vez de lançar outro reforço.
router.post('/movement', requireDeviceForCashOps, idempotency(), auditLog(AuditAction.UPDATE, 'CashRegister'), async (req: Request, res: Response) => {
  try {
    if (!req.body.cashRegisterId) {
      return res.status(400).json({ error: 'cashRegisterId is required' });
    }

    const data = cashMovementSchema.parse({
      ...req.body,
      userId: (req as any).user.userId,
    });

    if (data.movementType !== 'WITHDRAWAL' && data.movementType !== 'DEPOSIT') {
      return res.status(400).json({ error: 'movementType must be WITHDRAWAL or DEPOSIT' });
    }

    const movement = await cashRegisterService.addCashMovement({
      cashRegisterId: req.body.cashRegisterId,
      companyId: (req as any).user.companyId,
      movementType: data.movementType,
      amount: data.amount,
      notes: data.notes ?? undefined,
      userId: data.userId,
      requesterBranchId: (req as any).user.branchId,
      requesterUserType: (req as any).user.userType,
    });

    return res.status(201).json(movement);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Retirada de caixa (sangria) com dupla autorização — rota dedicada e mais
// restritiva que POST /movement (que agora só aceita DEPOSIT). Usa o mesmo
// limitador de segunda autorização (rateLimitAuthorizer, balde próprio por operador) porque esta rota também
// valida senha + MFA de um segundo usuário — é, na prática, uma segunda
// autenticação, com o mesmo risco de força bruta que o login/MFA têm.
router.post(
  '/:id/withdrawal',
  requireDeviceForCashOps,
  rateLimitAuthorizer,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'CashMovement'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const user = (req as any).user;
      const data = cashWithdrawalSchema.parse(req.body);

      const result = await cashRegisterService.requestWithdrawal({
        cashRegisterId: id,
        companyId: user.companyId,
        branchId: user.branchId,
        requesterUserType: user.userType,
        requesterId: user.userId,
        amount: data.amount,
        reason: data.reason,
        authorizerNumericId: data.authorizerNumericId,
        authorizerPassword: data.authorizerPassword,
        authorizerMfaCode: data.authorizerMfaCode,
        requestId: (req as any).requestId,
        device: req.headers['x-device-type'] as string | undefined,
      });

      return res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }
);

export default router;
