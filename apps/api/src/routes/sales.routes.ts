import { Router, Request, Response } from 'express';
import saleService from '../services/sale.service';
import { resolveListCompanyId } from '../utils/tenant-scope';
import { createSaleSchema, saleFilterSchema, cancelSaleSchema, returnSaleSchema } from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, requireUserType, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { rateLimitAuthorizer } from '../middlewares/advancedRateLimit';
import { idempotency } from '../middleware/idempotency';
import { requireDeviceForCashOps } from '../middleware/device';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('VENDAS'));
// MECHANIC (oficina) não lê vendas: itens com custo, pagamentos com dados de cartão, faturamento.
router.use(denyUserTypes('MECHANIC'));

// Listar vendas
router.get('/', async (req: Request, res: Response) => {
  try {
    const filters = saleFilterSchema.parse({
      ...req.query,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    });

    const result = await saleService.listSales({
      ...filters,
      companyId: resolveListCompanyId((req as any).user, filters.companyId),
    });

    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Estatísticas de vendas
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const { branchId, startDate, endDate } = req.query;
    const companyId = (req as any).user.companyId;

    const stats = await saleService.getSalesStats(
      companyId,
      branchId as string,
      startDate as string,
      endDate as string
    );

    res.json(stats);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Buscar venda por ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;

    const sale = await saleService.getSaleById(id, companyId);

    if (!sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    return res.json(sale);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA: nenhum write deste arquivo tinha trava de papel —
// VIEWER (só-leitura em todo o resto do sistema) conseguia criar venda (baixa
// de estoque + pagamento + caixa) e pedir cancelamento/devolução (a dupla
// autorização exige as credenciais de um gerente, mas quem PEDE não era
// checado), e um MECHANIC idem. Chamadores reais: PDV (criar/cancelar/
// devolver, operado por OPERATOR/MANAGER) e admin-web (cancelar, backoffice)
// — nenhum frontend de oficina/mobile/tv vende. Trava: só quem opera venda.
// GETs (lista, stats, detalhe) continuam abertos ao tenant.
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'));

// Criar venda
router.post('/', requireDeviceForCashOps, idempotency(), auditLog(AuditAction.CREATE, 'Sale'), async (req: Request, res: Response) => {
  try {
    const data = createSaleSchema.parse({
      ...req.body,
      companyId: (req as any).user.companyId,
      userId: (req as any).user.userId,
    });

    const sale = await saleService.createSale({
      ...data,
      userType: (req as any).user.userType,
      customerId: data.customerId ?? undefined,
      partnerId: data.partnerId ?? undefined,
      notes: data.notes ?? undefined,
      discountAuthorizerNumericId: data.discountAuthorizerNumericId ?? undefined,
      discountAuthorizerPassword: data.discountAuthorizerPassword ?? undefined,
      discountAuthorizerMfaCode: data.discountAuthorizerMfaCode ?? undefined,
      discountReason: data.discountReason ?? undefined,
      items: data.items.map((item) => ({
        ...item,
        notes: item.notes ?? undefined,
      })),
    });

    res.status(201).json(sale);
  } catch (error: any) {
    // Recusas de regra com status próprio (AppError): 409 DISCOUNT_AUTHORIZATION_REQUIRED leva `details` (limite livre
    // vigente, percentual pedido, tipo) para o PDV pedir o autorizador; 409 DISCOUNT_LIMIT_EXCEEDED; 400 sem motivo.
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 400;
    res.status(status).json({
      error: error.message,
      ...(typeof error?.statusCode === 'number' && error.code ? { code: error.code } : {}),
      ...(error?.details ? { details: error.details } : {}),
    });
  }
});

// Cancelar venda finalizada — exige dupla autorização (mesmo padrão de
// retirada de caixa), por isso usa o mesmo limitador anti-força-bruta.
router.post(
  '/:id/cancel',
  rateLimitAuthorizer,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'Sale'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const user = (req as any).user;
      const data = cancelSaleSchema.parse({
        ...req.body,
        userId: user.userId,
      });

      const sale = await saleService.cancelSale({
        id,
        companyId: user.companyId,
        branchId: user.branchId,
        requesterId: user.userId,
        reason: data.reason,
        authorizerNumericId: data.authorizerNumericId,
        authorizerPassword: data.authorizerPassword,
        authorizerMfaCode: data.authorizerMfaCode,
        requestId: (req as any).requestId,
        device: req.headers['x-device-type'] as string | undefined,
      });

      res.json({ success: true, data: sale });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// Devolver venda — exige dupla autorização (mesmo padrão de cancelSale):
// devolução faz o mesmo estorno financeiro (pagamento REFUNDED, ajuste de
// caixa) que o cancelamento, então usa o mesmo limitador anti-força-bruta.
router.post(
  '/:id/return',
  rateLimitAuthorizer,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'Sale'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const user = (req as any).user;
      const data = returnSaleSchema.parse({
        ...req.body,
        userId: user.userId,
      });

      const sale = await saleService.returnSale({
        id,
        companyId: user.companyId,
        branchId: user.branchId,
        requesterId: user.userId,
        reason: data.reason,
        items: data.items,
        authorizerNumericId: data.authorizerNumericId,
        authorizerPassword: data.authorizerPassword,
        authorizerMfaCode: data.authorizerMfaCode,
        requestId: (req as any).requestId,
        device: req.headers['x-device-type'] as string | undefined,
      });

      res.json(sale);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

export default router;
