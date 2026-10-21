import { Router, Request, Response, NextFunction } from 'express';
import financialService from '../services/financial.service';
import {
  createPayableSchema,
  createReceivableSchema,
  reverseAccountSchema,
} from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { requirePermission } from '../middleware/permission';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { resolveWriteBranchId } from '../utils/branch-context';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('FINANCEIRO'));
// MECHANIC (oficina) não lê contas a pagar/receber nem fluxo de caixa.
router.use(denyUserTypes('MECHANIC'));

// ACHADO DE AUDITORIA DE INTEGRAÇÃO: só /pay e /reverse tinham
// requirePermission — criar/cancelar contas a pagar/receber (dinheiro real
// entrando/saindo do controle financeiro) ficava acessível a qualquer
// usuário autenticado do tenant. finance:manage cobre criar (registro,
// menor risco que mover dinheiro); finance:reverse cobre cancelar (desfaz
// um registro financeiro); finance:pay cobre receber (dinheiro
// efetivamente confirmado), mesmo permissão já usada para o pagamento de
// OS por ser a mesma classe de ação.
function parseQueryFilters(req: Request) {
  return {
    companyId: (req as any).user.companyId,
    branchId: req.query.branchId as string,
    status: req.query.status as string,
    startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
    endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
    page: req.query.page ? parseInt(req.query.page as string) : 1,
    limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
  };
}

// ---------- CONTAS A PAGAR ----------

router.get('/payables', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await financialService.listPayables({
      ...parseQueryFilters(req),
      supplierId: req.query.supplierId as string,
    });
    res.json(result);
  } catch (error: any) {
    next(error);
  }
});

router.post('/payables', requirePermission('finance:manage'), auditLog(AuditAction.CREATE, 'AccountsPayable'), async (req: Request, res: Response) => {
  try {
    const data = createPayableSchema.parse(req.body);
    const payable = await financialService.createPayable({
      ...data,
      branchId: await resolveWriteBranchId((req as any).user, data.branchId),
      dueDate: new Date(data.dueDate),
      companyId: (req as any).user.companyId,
    });
    res.status(201).json(payable);
  } catch (error: any) {
    res.status(error.statusCode ?? 400).json({ error: error.message });
  }
});

router.post(
  '/payables/:id/pay',
  requirePermission('finance:pay'),
  auditLog(AuditAction.UPDATE, 'AccountsPayable'),
  async (req: Request, res: Response) => {
    try {
      const payable = await financialService.payPayable(req.params.id, (req as any).user.companyId);
      res.json(payable);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

router.post('/payables/:id/cancel', requirePermission('finance:reverse'), auditLog(AuditAction.UPDATE, 'AccountsPayable'), async (req: Request, res: Response) => {
  try {
    const payable = await financialService.cancelPayable(req.params.id, (req as any).user.companyId, req.body?.reason);
    res.json(payable);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post(
  '/payables/:id/reverse',
  requirePermission('finance:reverse'),
  auditLog(AuditAction.UPDATE, 'AccountsPayable'),
  async (req: Request, res: Response) => {
    try {
      const { reason } = reverseAccountSchema.parse(req.body);
      const reversal = await financialService.reversePayable(req.params.id, (req as any).user.companyId, reason);
      res.status(201).json(reversal);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

// ---------- CONTAS A RECEBER ----------

router.get('/receivables', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await financialService.listReceivables({
      ...parseQueryFilters(req),
      customerId: req.query.customerId as string,
    });
    res.json(result);
  } catch (error: any) {
    next(error);
  }
});

router.post('/receivables', requirePermission('finance:manage'), auditLog(AuditAction.CREATE, 'AccountsReceivable'), async (req: Request, res: Response) => {
  try {
    const data = createReceivableSchema.parse(req.body);
    const receivable = await financialService.createReceivable({
      ...data,
      branchId: await resolveWriteBranchId((req as any).user, data.branchId),
      dueDate: new Date(data.dueDate),
      companyId: (req as any).user.companyId,
    });
    res.status(201).json(receivable);
  } catch (error: any) {
    res.status(error.statusCode ?? 400).json({ error: error.message });
  }
});

router.post(
  '/receivables/:id/receive',
  requirePermission('finance:pay'),
  auditLog(AuditAction.UPDATE, 'AccountsReceivable'),
  async (req: Request, res: Response) => {
    try {
      const receivable = await financialService.receivePayment(req.params.id, (req as any).user.companyId);
      res.json(receivable);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

router.post(
  '/receivables/:id/cancel',
  requirePermission('finance:reverse'),
  auditLog(AuditAction.UPDATE, 'AccountsReceivable'),
  async (req: Request, res: Response) => {
    try {
      const receivable = await financialService.cancelReceivable(
        req.params.id,
        (req as any).user.companyId,
        req.body?.reason
      );
      res.json(receivable);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

router.post(
  '/receivables/:id/reverse',
  requirePermission('finance:reverse'),
  auditLog(AuditAction.UPDATE, 'AccountsReceivable'),
  async (req: Request, res: Response) => {
    try {
      const { reason } = reverseAccountSchema.parse(req.body);
      const reversal = await financialService.reverseReceivable(req.params.id, (req as any).user.companyId, reason);
      res.status(201).json(reversal);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

// ---------- FLUXO DE CAIXA ----------

router.get('/cash-flow', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await financialService.getCashFlowSummary(
      (req as any).user.companyId,
      req.query.branchId as string,
      req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      req.query.endDate ? new Date(req.query.endDate as string) : undefined
    );
    res.json(summary);
  } catch (error: any) {
    next(error);
  }
});

export default router;
