import { Router, Request, Response, NextFunction } from 'express';
import { AuditAction } from '@ln-system/database';
import { authMiddleware, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { idempotency } from '../middleware/idempotency';
import collectionService from '../services/collection.service';
import { companyIdOf } from './policies.routes';

/**
 * Conta a receber: detalhe e COBRANÇA MANUAL (docs/CORTEX/policies/COBRANCA.md). O fluxo de criar/receber/cancelar/
 * estornar continua em /financial/receivables.
 *  GET  /receivables/:id              detalhe (devedor, atraso, juros/multa informativos, tentativas)
 *  GET  /receivables/:id/collections  histórico de tentativas de cobrança
 *  POST /receivables/:id/collections  { channels: ['WHATSAPP'|'EMAIL'] } — UMA mensagem por canal nesta ação humana.
 *                                     Perfil conferido pela política `collection.allowedRoles` (403 COLLECTION_FORBIDDEN).
 * Não existe job nem rota de envio automático.
 */
const router = Router();
router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('FINANCEIRO'));
router.use(denyUserTypes('MECHANIC'));

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await collectionService.receivableDetail(companyIdOf(req), req.params.id));
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/collections', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json({ data: await collectionService.history(companyIdOf(req), req.params.id) });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/:id/collections',
  idempotency(),
  auditLog(AuditAction.CREATE, 'CollectionAttempt', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        acao: 'COBRANCA_MANUAL',
        conta: req.params.id,
        canais: (body?.attempts ?? []).map((a: any) => ({ canal: a.channel, resultado: a.status })),
      },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await collectionService.send({
        companyId: companyIdOf(req),
        userId: user.userId,
        userType: user.userType,
        receivableId: req.params.id,
        body: req.body,
      });
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
