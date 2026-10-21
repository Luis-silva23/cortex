import { Router, Request, Response, NextFunction } from 'express';
import { AuditAction } from '@ln-system/database';
import { AuthorizationError } from '@ln-system/shared';
import { authMiddleware, requireUserType, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { idempotency } from '../middleware/idempotency';
import employeeAgreementService from '../services/employee-agreement.service';
import { ADMIN_ROLES, MANAGEMENT_ROLES, SELLING_ROLES } from '../services/agreement-common';
import { companyIdOf } from './policies.routes';

/**
 * Convênio de FUNCIONÁRIO (desconto em folha) — docs/CORTEX/policies/CONVENIOS.md. Não é o "convênio de desconto"
 * (/partners).
 *  GET  /employee-agreements/lookup?q=                  PDV (quem vende): ativos, sem salário
 *  GET  /employee-agreements/deductions?competence=     folha da competência (gerência+)
 *  POST /employee-agreements/deductions/:id/process     baixa da parcela processada na folha (gerência+)
 *  GET  /employee-agreements                            lista (gerência+; inclui salário)
 *  POST /employee-agreements                            cadastro (gerência+)
 *  GET  /employee-agreements/:id                        detalhe com utilizações e parcelas (gerência+)
 *  PATCH /employee-agreements/:id                       alteração / situação (gerência+)
 *  GET  /employee-agreements/:id/statement?competence=  espelho do funcionário (gerência+ ou o próprio funcionário)
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);
router.use(denyUserTypes('MECHANIC'));

const management = requireUserType(...MANAGEMENT_ROLES);
// Autorizar convênio (cadastrar, mudar limite/filiais/situação, desbloquear) é da administração; gerência consulta e bloqueia.
const administration = requireUserType(...ADMIN_ROLES);

router.get('/lookup', requireUserType(...SELLING_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    return res.json(await employeeAgreementService.lookup(companyIdOf(req), user.branchId ?? null, String(req.query.q ?? '')));
  } catch (error) {
    return next(error);
  }
});

router.get('/deductions', management, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(
      await employeeAgreementService.listDeductions(companyIdOf(req), (req.query.competence as string) || undefined, (req.query.status as string) || undefined)
    );
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/deductions/:id/process',
  management,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'EmployeePayrollDeduction', {
    describe: (req, body) => ({ entityId: req.params.id, newValue: { acao: 'BAIXA_EM_FOLHA', competencia: body?.competence, valor: body?.amount, situacao: body?.status } }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json(await employeeAgreementService.processDeduction(companyIdOf(req), req.params.id, (req as any).user.userId));
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/', management, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await employeeAgreementService.list(companyIdOf(req), { q: req.query.q as string, status: (req.query.status as string) || undefined }));
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/',
  administration,
  idempotency(),
  auditLog(AuditAction.CREATE, 'EmployeeAgreement', {
    describe: (_req, body) => ({
      entityId: body?.id,
      // Sem salário no audit (dado pessoal): só o que identifica o cadastro e o limite.
      newValue: { funcionario: body?.name, cpf: body?.cpfMasked, matricula: body?.registration, limite: body?.effectiveLimit, situacao: body?.status },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.status(201).json(await employeeAgreementService.create(companyIdOf(req), (req as any).user.userId, req.body));
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/:id', management, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await employeeAgreementService.get(companyIdOf(req), req.params.id));
  } catch (error) {
    return next(error);
  }
});

router.patch(
  '/:id',
  administration,
  auditLog(AuditAction.UPDATE, 'EmployeeAgreement', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        antes: body?.before ?? null,
        depois: body?.agreement ? { situacao: body.agreement.status, limite: body.agreement.effectiveLimit } : null,
        camposAlterados: Object.keys(req.body ?? {}),
      },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json(await employeeAgreementService.update(companyIdOf(req), req.params.id, req.body));
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/:id/statement', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    const companyId = companyIdOf(req);
    if (!(MANAGEMENT_ROLES as readonly string[]).includes(user.userType)) {
      // O próprio funcionário (usuário vinculado ao convênio) pode ver o seu espelho.
      const own = await employeeAgreementService.isOwnAgreement(companyId, req.params.id, user.userId);
      if (!own) throw new AuthorizationError('Acesso negado ao espelho de outro funcionário', 'FORBIDDEN');
    }
    return res.json(await employeeAgreementService.statement(companyId, req.params.id, (req.query.competence as string) || undefined));
  } catch (error) {
    return next(error);
  }
});

export default router;
