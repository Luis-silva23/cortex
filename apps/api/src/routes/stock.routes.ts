import { canAccessBranch } from '../utils/branch-access';
import { Router, Request, Response } from 'express';
import stockService from '../services/stock.service';
import { stockMovementSchema, stockAdjustmentSchema } from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { requirePermission } from '../middleware/permission';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { idempotency } from '../middleware/idempotency';
import { AppError, AuthorizationError } from '@ln-system/shared';
import { requireWriteBranchId } from '../utils/branch-context';

const router = Router();

// Filial de um movimento/ajuste de estoque. Sem filial o ajuste era calculado contra
// o saldo TOTAL da empresa e gravado com filial NULL — um movimento que não entra no
// saldo de nenhuma filial (o ledger deixava de fechar por filial). Padrão: a filial
// do token. COMPANY_ADMIN/SUPER_ADMIN (sem filial própria) precisam informar; quem é
// de uma filial só movimenta a sua (antes a RLS barrava com um erro cru).
function resolveMovementBranchId(user: { userType: string; branchId?: string | null; branchIds?: string[] }, requested?: string | null): string {
  const branchId = requested || user.branchId || undefined;
  if (!branchId) {
    throw new AppError('branchId é obrigatório: informe a filial do movimento de estoque', 400, 'BRANCH_REQUIRED');
  }
  const companyWide = user.userType === 'SUPER_ADMIN' || user.userType === 'COMPANY_ADMIN';
  if (!companyWide && user.branchId && !canAccessBranch(user, branchId)) {
    throw new AuthorizationError('Você só movimenta o estoque das filiais às quais está vinculado');
  }
  return branchId;
}

// AppError/AuthorizationError carregam o status certo (400/403); o resto segue 400 como antes.
const statusOf = (error: any) => (error?.statusCode && error.statusCode < 500 ? error.statusCode : 400);

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('ESTOQUE'));

// Disponível para venda (saldo − reservas vivas, a mesma conta que a venda confere) de até 50 produtos numa filial: consulta do
// Balcão e do Admin. Filial: a do token (quem é de uma filial só consulta a sua) ou, para quem é da empresa toda, uma filial DA empresa.
router.get('/availability', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const ids = String(req.query.productIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0 || ids.length > 50) throw new AppError('Informe de 1 a 50 produtos (productIds)', 400, 'PRODUCT_IDS_INVALID');
    const branchId = await requireWriteBranchId(user, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    res.json({ items: await stockService.getAvailability(user.companyId, branchId, ids) });
  } catch (error: any) {
    res.status(statusOf(error)).json({ error: error.message, ...(error?.code && typeof error.code === 'string' ? { code: error.code } : {}) });
  }
});

// Listar movimentações
router.get('/movements', async (req: Request, res: Response) => {
  try {
    const filters = {
      companyId: (req as any).user.companyId,
      branchId: req.query.branchId as string,
      productId: req.query.productId as string,
      movementType: req.query.movementType as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
    };

    const result = await stockService.listMovements(filters);

    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Consultar saldo de estoque de um produto
router.get('/balance/:productId', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { branchId } = req.query;

    const balance = await stockService.getBalance(
      productId,
      (req as any).user.companyId,
      branchId as string,
      undefined,
      { withHistory: true }
    );

    res.json(balance);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Relatório de estoque
router.get('/report', async (req: Request, res: Response) => {
  try {
    const filters = {
      companyId: (req as any).user.companyId,
      branchId: req.query.branchId as string,
      categoryId: req.query.categoryId as string,
      status: req.query.status as any,
    };

    const report = await stockService.getStockReport(filters);

    res.json({ items: report });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Pré-visualização de importação de estoque (wizard de Excel/CSV): verifica
// quais linhas (SKU/código de barras) casam com produtos existentes, sem
// criar nenhuma movimentação. Usado antes da confirmação para nunca
// descartar silenciosamente linhas sem produto correspondente.
router.post('/import/preview', async (req: Request, res: Response) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const result = await stockService.matchProductsForImport(
      (req as any).user.companyId,
      items
    );

    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA DE INTEGRAÇÃO: nenhuma das 4 rotas mutantes deste
// arquivo tinha requirePermission/idempotency — qualquer usuário
// autenticado do tenant podia escrever direto no ledger de estoque (a
// fonte da verdade do sistema), inclusive tipos de movimento sensíveis
// (LOSS, ADJUSTMENT) via /movement, sem nenhuma trava além de estar
// logado. A validação de branchId pertencer à empresa já foi corrigida em
// stock.service.ts (assertBranchBelongsToCompany) — aqui é a camada de
// autorização/idempotência.
// Criar movimentação
router.post(
  '/movement',
  idempotency(),
  requirePermission('stock:adjust'),
  auditLog(AuditAction.CREATE, 'StockMovement'),
  async (req: Request, res: Response) => {
    try {
      const data = stockMovementSchema.parse({
        ...req.body,
        companyId: (req as any).user.companyId,
        userId: (req as any).user.userId,
      });

      const movement = await stockService.createMovement({
        ...data,
        branchId: resolveMovementBranchId((req as any).user, data.branchId),
        notes: data.notes ?? undefined,
        referenceType: data.referenceType ?? undefined,
        referenceId: data.referenceId ?? undefined,
        unitCost: data.unitCost ?? undefined,
        totalCost: data.totalCost ?? undefined,
      });

      res.status(201).json(movement);
    } catch (error: any) {
      res.status(statusOf(error)).json({ error: error.message });
    }
  }
);

// Ajuste de estoque
router.post(
  '/adjustment',
  idempotency(),
  requirePermission('stock:adjust'),
  auditLog(AuditAction.CREATE, 'StockMovement'),
  async (req: Request, res: Response) => {
    try {
      const data = stockAdjustmentSchema.parse(req.body);

      const movement = await stockService.adjustStock({
        ...data,
        branchId: resolveMovementBranchId((req as any).user, data.branchId),
        companyId: (req as any).user.companyId,
        userId: (req as any).user.userId,
      });

      res.status(201).json(movement);
    } catch (error: any) {
      res.status(statusOf(error)).json({ error: error.message });
    }
  }
);

// Transferência entre filiais
router.post(
  '/transfer',
  idempotency(),
  requirePermission('stock:transfer'),
  auditLog(AuditAction.CREATE, 'StockMovement'),
  async (req: Request, res: Response) => {
    try {
      const { productId, fromBranchId, toBranchId, quantity, notes } = req.body;

      if (!productId || !fromBranchId || !toBranchId || !quantity) {
        return res.status(400).json({
          error: 'productId, fromBranchId, toBranchId, and quantity are required',
        });
      }

      const result = await stockService.transferStock({
        companyId: (req as any).user.companyId,
        productId,
        fromBranchId,
        toBranchId,
        quantity: parseFloat(quantity),
        notes,
        userId: (req as any).user.userId,
      });

      return res.status(201).json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

// Inventário (contagem física)
router.post(
  '/inventory',
  idempotency(),
  requirePermission('stock:adjust'),
  auditLog(AuditAction.CREATE, 'StockMovement'),
  async (req: Request, res: Response) => {
    try {
      const { branchId, items, notes } = req.body;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items array is required' });
      }

      const result = await stockService.performInventory({
        companyId: (req as any).user.companyId,
        branchId,
        items,
        notes,
        userId: (req as any).user.userId,
      });

      return res.status(201).json({ results: result });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

export default router;
