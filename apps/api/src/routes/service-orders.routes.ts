import { Router, Request, Response, NextFunction } from 'express';
import serviceOrderService from '../services/service-order.service';
import vehicleEntryChecklistService from '../services/vehicle-entry-checklist.service';
import {
  createServiceOrderSchema,
  addServiceOrderItemSchema,
  transitionServiceOrderStatusSchema,
} from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { requirePermission } from '../middleware/permission';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { requireWriteBranchId } from '../utils/branch-context';
import { AppError } from '@ln-system/shared';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('OFICINA'));

// ACHADO DE AUDITORIA: nenhuma escrita de OS tinha trava de papel (a nota mais
// abaixo, em /:id/payment, tratava as demais como "qualquer funcionário do
// tenant" — mas VIEWER é só-leitura em todo o resto do sistema). Efeito real:
// VIEWER criava OS, adicionava item (em EXECUÇÃO+ isso baixa estoque na
// hora), movia o status (finalizar/cancelar), atribuía mecânico e registrava
// checklist de entrada. Chamador: admin-web (sem restrição de papel na tela);
// mobile/tv só leem OS. Exclui só o VIEWER (OPERATOR e MECHANIC são os atores
// naturais da oficina); os GETs e /:id/payment (requirePermission) não mudam.
const requireWorkshopWriter = requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC');

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await serviceOrderService.list({
      companyId: (req as any).user.companyId,
      branchId: req.query.branchId as string,
      status: req.query.status as string,
      mechanicId: req.query.mechanicId as string,
      customerId: typeof req.query.customerId === 'string' ? req.query.customerId : undefined,
      motorcycleId: typeof req.query.motorcycleId === 'string' ? req.query.motorcycleId : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    });
    res.json(result);
  } catch (error: any) {
    next(error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const os = await serviceOrderService.getById(req.params.id, (req as any).user.companyId);
    if (!os) {
      return res.status(404).json({ error: 'Service order not found' });
    }
    return res.json(os);
  } catch (error: any) {
    return next(error);
  }
});

router.post('/', requireWorkshopWriter, auditLog(AuditAction.CREATE, 'ServiceOrder'), async (req: Request, res: Response) => {
  try {
    const data = createServiceOrderSchema.parse(req.body);
    const user = (req as any).user;
    const os = await serviceOrderService.create({
      ...data,
      branchId: await requireWriteBranchId(user, data.branchId),
      companyId: user.companyId,
      userId: user.userId,
    });
    res.status(201).json(os);
  } catch (error: any) {
    res.status(error.statusCode ?? 400).json({ error: error.message });
  }
});

// A resposta é `{ item, serviceOrder }` (sem `data`): o audit é descrito aqui, com
// o que FOI cobrado (o preço de PART com productId vem do catálogo, não do corpo).
router.post(
  '/:id/items',
  requireWorkshopWriter,
  auditLog(AuditAction.UPDATE, 'ServiceOrder', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        action: 'ADD_ITEM',
        itemId: body?.item?.id,
        itemType: body?.item?.itemType,
        productId: body?.item?.productId ?? null,
        description: body?.item?.description,
        quantity: body?.item?.quantity !== undefined ? Number(body.item.quantity) : undefined,
        unitPrice: body?.item?.unitPrice !== undefined ? Number(body.item.unitPrice) : undefined,
        totalPrice: body?.item?.totalPrice !== undefined ? Number(body.item.totalPrice) : undefined,
      },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      const data = addServiceOrderItemSchema.parse(req.body);
      const result = await serviceOrderService.addItem(req.params.id, (req as any).user.companyId, data, (req as any).user.userId);
      res.status(201).json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

// Encerramento (ENCERRADA) leva a decisão de garantia no corpo (`warranty`) — docs/CORTEX/policies/GARANTIA.md.
// A auditoria registra a transição e, no encerramento, a decisão e a garantia criada.
router.post(
  '/:id/status',
  requireWorkshopWriter,
  auditLog(AuditAction.UPDATE, 'ServiceOrder', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        action: 'STATUS',
        toStatus: body?.status ?? req.body?.toStatus,
        notes: req.body?.notes ?? null,
        ...(body?.status === 'ENCERRADA'
          ? {
              warrantyDecision: body?.warrantyDecision ?? null,
              warranty: body?.warranty
                ? {
                    id: body.warranty.id,
                    coverage: body.warranty.coverage,
                    durationValue: body.warranty.durationValue,
                    durationUnit: body.warranty.durationUnit,
                    kmLimit: body.warranty.kmLimit ?? null,
                    startDate: body.warranty.startDate,
                    validUntil: body.warranty.validUntil,
                    startKm: body.warranty.startKm !== null && body.warranty.startKm !== undefined ? Number(body.warranty.startKm) : null,
                    kmUntil: body.warranty.kmUntil !== null && body.warranty.kmUntil !== undefined ? Number(body.warranty.kmUntil) : null,
                  }
                : null,
            }
          : {}),
      },
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { toStatus, notes, warranty } = transitionServiceOrderStatusSchema.parse(req.body);
      const os = await serviceOrderService.transitionStatus(
        req.params.id,
        (req as any).user.companyId,
        toStatus,
        (req as any).user.userId,
        notes,
        { warranty }
      );
      res.json(os);
    } catch (error: any) {
      // Recusas de regra com código (garantia: WARRANTY_DECISION_REQUIRED, WARRANTY_DISABLED…) seguem o formato
      // { message, code, statusCode } do errorHandler; os demais erros mantêm o 400 { error } de sempre.
      if (error instanceof AppError) return next(error);
      res.status(400).json({ error: error.message });
    }
  }
);

// Quem recebe a comissão muda aqui: auditado (a resposta é a OS crua, sem `data`).
router.post(
  '/:id/mechanic',
  requireWorkshopWriter,
  auditLog(AuditAction.UPDATE, 'ServiceOrder', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: { action: 'ASSIGN_MECHANIC', mechanicId: req.body?.mechanicId, resultMechanicId: body?.mechanicId ?? null },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      const { mechanicId } = req.body;
      if (!mechanicId) {
        return res.status(400).json({ error: 'mechanicId is required' });
      }
      const user = (req as any).user;
      const os = await serviceOrderService.assignMechanic(req.params.id, user.companyId, mechanicId, {
        userId: user.userId,
        userType: user.userType,
      });
      return res.json(os);
    } catch (error: any) {
      // AuthorizationError (ex.: MECHANIC tentando pegar a OS de outro) é 403.
      return res.status(error?.statusCode === 403 ? 403 : 400).json({ error: error.message });
    }
  }
);

router.put('/:id/estimated-delivery', requireWorkshopWriter, async (req: Request, res: Response) => {
  try {
    const { estimatedDelivery } = req.body;
    const os = await serviceOrderService.setEstimatedDelivery(
      req.params.id,
      (req as any).user.companyId,
      estimatedDelivery ? new Date(estimatedDelivery) : null
    );
    return res.json(os);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA DE INTEGRAÇÃO: única rota que "realiza" dinheiro de
// uma OS (cria AccountsReceivable já quitada — ver registerPayment) e,
// diferente do endpoint equivalente em financial.routes.ts
// (`/payables/:id/pay`, `requirePermission('finance:pay')`), não tinha
// NENHUMA trava de permissão — qualquer usuário autenticado do tenant,
// inclusive VIEWER, podia registrar pagamento de OS via chamada direta à
// API. As demais rotas deste arquivo (criar OS, mudar status, atribuir
// mecânico) seguem o mesmo padrão operacional usado em sales/stock/
// customers routes (qualquer funcionário do tenant, exceto o VIEWER — ver requireWorkshopWriter), então só
// esta, que é genuinamente financeira, precisa do gate.
router.post('/:id/payment', requirePermission('finance:pay'), auditLog(AuditAction.UPDATE, 'ServiceOrder'), async (req: Request, res: Response) => {
  try {
    const { paymentMethod } = req.body;
    if (!paymentMethod) {
      return res.status(400).json({ error: 'paymentMethod is required' });
    }
    const os = await serviceOrderService.registerPayment(req.params.id, (req as any).user.companyId, paymentMethod);
    return res.json(os);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.post(
  '/:id/entry-checklist',
  requireWorkshopWriter,
  auditLog(AuditAction.CREATE, 'VehicleEntryChecklist'),
  async (req: Request, res: Response) => {
    try {
      const { motorcycleId, items } = req.body;
      if (!motorcycleId || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'motorcycleId and a non-empty items array are required' });
      }
      const checklist = await vehicleEntryChecklistService.create({
        serviceOrderId: req.params.id,
        companyId: (req as any).user.companyId,
        motorcycleId,
        checkedBy: (req as any).user.userId,
        items,
      });
      return res.status(201).json(checklist);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

router.get('/:id/entry-checklist', async (req: Request, res: Response) => {
  try {
    const checklist = await vehicleEntryChecklistService.getByServiceOrderId(
      req.params.id,
      (req as any).user.companyId
    );
    if (!checklist) {
      return res.status(404).json({ error: 'Entry checklist not found for this service order' });
    }
    return res.json(checklist);
  } catch (error: any) {
    // OS não encontrada (ou de outra empresa — mesma resposta, nunca
    // vaza se a OS existe em outro tenant) também é um "não encontrado",
    // não um erro de validação genérico.
    if (error.message === 'Service order not found') {
      return res.status(404).json({ error: error.message });
    }
    return res.status(400).json({ error: error.message });
  }
});

export default router;
