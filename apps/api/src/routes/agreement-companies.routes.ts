import { Router, Request, Response, NextFunction } from 'express';
import { AuditAction } from '@ln-system/database';
import { authMiddleware, requireUserType, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { idempotency } from '../middleware/idempotency';
import agreementCompanyService from '../services/agreement-company.service';
import { ADMIN_ROLES, MANAGEMENT_ROLES, SELLING_ROLES } from '../services/agreement-common';
import { companyIdOf } from './policies.routes';

/**
 * Convênio com EMPRESA EXTERNA (venda a prazo → conta a receber) — docs/CORTEX/policies/CONVENIOS.md / FINANCEIRO.md.
 *  GET  /agreement-companies/lookup?q=     PDV (quem vende): ativas e bloqueadas (status BLOCKED visível ao caixa)
 *  GET  /agreement-companies               lista com saldo/utilizado/disponível/vencido (gerência+)
 *  POST /agreement-companies               cadastro (gerência+)
 *  GET  /agreement-companies/:id           detalhe: resumo, contas, histórico (gerência+)
 *  GET  /agreement-companies/:id/summary   saldo, utilizado, disponível, vencido, dias de atraso, inadimplência
 *  PATCH /agreement-companies/:id          alteração (gerência+)
 *  POST /agreement-companies/:id/block     bloqueio manual com motivo (gerência+, auditado)
 *  POST /agreement-companies/:id/unblock   desbloqueio manual com motivo (gerência+, auditado)
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
    return res.json(await agreementCompanyService.lookup(companyIdOf(req), user.branchId ?? null, String(req.query.q ?? '')));
  } catch (error) {
    return next(error);
  }
});

router.get('/', management, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await agreementCompanyService.list(companyIdOf(req), { q: req.query.q as string, status: (req.query.status as string) || undefined }));
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/',
  administration,
  idempotency(),
  auditLog(AuditAction.CREATE, 'AgreementCompany'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.status(201).json(await agreementCompanyService.create(companyIdOf(req), (req as any).user.userId, req.body));
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/:id', management, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await agreementCompanyService.detail(companyIdOf(req), req.params.id));
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/summary', management, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await agreementCompanyService.summary(companyIdOf(req), req.params.id));
  } catch (error) {
    return next(error);
  }
});

router.patch(
  '/:id',
  administration,
  auditLog(AuditAction.UPDATE, 'AgreementCompany', {
    describe: (req, body) => ({ entityId: req.params.id, newValue: { antes: body?.before ?? null, depois: body?.agreement ?? null } }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json(await agreementCompanyService.update(companyIdOf(req), req.params.id, req.body));
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/:id/block',
  management,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'AgreementCompanyBlock', {
    describe: (req, body) => ({ entityId: req.params.id, newValue: { acao: 'BLOQUEIO_MANUAL', motivo: req.body?.reason ?? null, situacao: body?.status } }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json(await agreementCompanyService.block(companyIdOf(req), req.params.id, (req as any).user.userId, req.body?.reason));
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/:id/unblock',
  administration,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'AgreementCompanyBlock', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: { acao: 'DESBLOQUEIO_MANUAL', motivo: req.body?.reason ?? null, bloqueioAnterior: body?.previousBlock ?? null },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json(await agreementCompanyService.unblock(companyIdOf(req), req.params.id, (req as any).user.userId, req.body?.reason));
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
