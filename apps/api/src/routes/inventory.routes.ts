import { Router, Request, Response } from 'express';
import inventoryService from '../services/inventory.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('ESTOQUE'));

// ACHADO DE AUDITORIA: abrir sessão de inventário e lançar contagem não tinham
// trava de papel (só fechar/cancelar, que exigem Gerência+) — VIEWER, papel
// só-leitura no resto do sistema, conseguia abrir inventário e lançar
// contagens que o fechamento depois transforma em ajuste de estoque. O único
// chamador é o admin-web (sem restrição de papel na tela), então exclui só o
// VIEWER (mesmo padrão de quotes/appointments); as duas rotas de leitura e as
// de fechar/cancelar não mudam.
const requireStockWriter = requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC');

// Iniciar inventário (planejamento) — qualquer funcionário (exceto VIEWER) da
// empresa pode abrir uma sessão de contagem na sua filial.
router.post('/', requireStockWriter, auditLog(AuditAction.CREATE, 'Inventory'), async (req: Request, res: Response) => {
  try {
    const { branchId, notes } = req.body;
    if (!branchId) {
      return res.status(400).json({ error: 'branchId é obrigatório' });
    }
    const inventory = await inventoryService.start({
      companyId: (req as any).user.companyId,
      branchId,
      startedBy: (req as any).user.userId,
      notes,
    });
    return res.status(201).json(inventory);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const inventories = await inventoryService.listByCompany(
      (req as any).user.companyId,
      req.query.branchId as string | undefined
    );
    res.json({ inventories });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const inventory = await inventoryService.getById(req.params.id, (req as any).user.companyId);
    res.json(inventory);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

// Registrar contagem de um produto (chamar de novo com o mesmo produto =
// recontagem, atualiza a mesma linha).
router.post('/:id/counts', requireStockWriter, auditLog(AuditAction.UPDATE, 'InventoryCount'), async (req: Request, res: Response) => {
  try {
    const { productId, countedQuantity, notes } = req.body;
    if (!productId || countedQuantity === undefined || countedQuantity === null) {
      return res.status(400).json({ error: 'productId e countedQuantity são obrigatórios' });
    }
    const count = await inventoryService.addCount({
      inventoryId: req.params.id,
      companyId: (req as any).user.companyId,
      productId,
      countedQuantity: Number(countedQuantity),
      countedBy: (req as any).user.userId,
      notes,
    });
    return res.status(201).json(count);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Fechamento = aprovação — exige Gerente/Admin/Super Admin, não qualquer
// operador que tenha feito a contagem (separação de função: quem conta não
// é necessariamente quem aprova o ajuste de estoque resultante).
router.post(
  '/:id/close',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Inventory'),
  async (req: Request, res: Response) => {
    try {
      const inventory = await inventoryService.close({
        inventoryId: req.params.id,
        companyId: (req as any).user.companyId,
        closedBy: (req as any).user.userId,
      });
      return res.json(inventory);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

router.post(
  '/:id/cancel',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Inventory'),
  async (req: Request, res: Response) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ error: 'reason é obrigatório' });
      }
      const inventory = await inventoryService.cancel({
        inventoryId: req.params.id,
        companyId: (req as any).user.companyId,
        reason,
      });
      return res.json(inventory);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

export default router;
