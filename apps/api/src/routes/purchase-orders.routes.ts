import { Router, Request, Response, NextFunction } from 'express';
import purchaseOrderService from '../services/purchase-order.service';
import {
  createPurchaseOrderSchema,
  receivePurchaseOrderSchema,
  returnToSupplierSchema,
} from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { requirePermission } from '../middleware/permission';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { idempotency } from '../middleware/idempotency';
import { requireWriteBranchId } from '../utils/branch-context';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('COMPRAS'));
// MECHANIC (oficina) não lê pedidos de compra (custo unitário e total).
router.use(denyUserTypes('MECHANIC'));

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await purchaseOrderService.list({
      companyId: (req as any).user.companyId,
      branchId: req.query.branchId as string,
      supplierId: req.query.supplierId as string,
      status: req.query.status as string,
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
    const po = await purchaseOrderService.getById(req.params.id, (req as any).user.companyId);
    if (!po) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }
    return res.json(po);
  } catch (error: any) {
    return next(error);
  }
});

router.post('/', requirePermission('purchases:manage'), auditLog(AuditAction.CREATE, 'PurchaseOrder'), async (req: Request, res: Response) => {
  try {
    const data = createPurchaseOrderSchema.parse(req.body);
    const user = (req as any).user;
    const po = await purchaseOrderService.create({
      ...data,
      branchId: await requireWriteBranchId(user, data.branchId),
      companyId: user.companyId,
      expectedDelivery: data.expectedDelivery ? new Date(data.expectedDelivery) : undefined,
    });
    res.status(201).json(po);
  } catch (error: any) {
    res.status(error.statusCode ?? 400).json({ error: error.message });
  }
});

// Aprovação exige permissão específica — pedido de compra tem impacto
// financeiro (I8.4: approval requirement no schema).
router.post(
  '/:id/approve',
  requirePermission('purchases:approve'),
  auditLog(AuditAction.UPDATE, 'PurchaseOrder'),
  async (req: Request, res: Response) => {
    try {
      const po = await purchaseOrderService.approve(req.params.id, (req as any).user.companyId, (req as any).user.userId);
      res.json(po);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

router.post('/:id/cancel', requirePermission('purchases:manage'), auditLog(AuditAction.UPDATE, 'PurchaseOrder'), async (req: Request, res: Response) => {
  try {
    const po = await purchaseOrderService.cancel(req.params.id, (req as any).user.companyId);
    res.json(po);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA DE INTEGRAÇÃO: receive/return alteram estoque real
// (o único ponto que de fato baixa/sobe o ledger para um pedido de compra)
// e ficavam sem NENHUM gate — só /approve tinha requirePermission. create/
// cancel usam purchases:manage (mais baixo risco, ainda DRAFT/sem estoque
// tocado); receive/return usam purchases:receive (mexe em estoque de
// verdade).
router.post(
  '/:id/receive',
  idempotency(),
  requirePermission('purchases:receive'),
  auditLog(AuditAction.UPDATE, 'PurchaseOrder'),
  async (req: Request, res: Response) => {
    try {
      const data = receivePurchaseOrderSchema.parse(req.body);
      const po = await purchaseOrderService.receive(req.params.id, (req as any).user.companyId, {
        ...data,
        invoice: data.invoice
          ? { ...data.invoice, issueDate: new Date(data.invoice.issueDate) }
          : undefined,
        userId: (req as any).user.userId,
      });
      res.json(po);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

router.post(
  '/:id/return',
  requirePermission('purchases:receive'),
  auditLog(AuditAction.UPDATE, 'PurchaseOrder'),
  async (req: Request, res: Response) => {
    try {
      const data = returnToSupplierSchema.parse(req.body);
      const movement = await purchaseOrderService.returnToSupplier(req.params.id, (req as any).user.companyId, {
        ...data,
        userId: (req as any).user.userId,
      });
      res.json(movement);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

export default router;
