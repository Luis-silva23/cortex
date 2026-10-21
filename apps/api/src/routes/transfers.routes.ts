import { Router, Request, Response } from 'express';
import transferService from '../services/transfer.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('ESTOQUE'));

// ACHADO DE AUDITORIA: solicitar, enviar e receber transferência não tinham
// trava de papel (só aprovar/rejeitar/cancelar, que exigem Gerência+) —
// VIEWER, papel só-leitura no resto do sistema, conseguia movimentar estoque
// entre filiais (enviar baixa a origem; receber dá entrada no destino). O
// único chamador é o admin-web (sem restrição de papel na tela), então
// exclui só o VIEWER (mesmo padrão de quotes/appointments).
const requireStockWriter = requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC');

router.post('/', requireStockWriter, auditLog(AuditAction.CREATE, 'Transfer'), async (req: Request, res: Response) => {
  try {
    const { fromBranchId, toBranchId, items, notes } = req.body;
    if (!fromBranchId || !toBranchId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'fromBranchId, toBranchId e items são obrigatórios' });
    }
    const transfer = await transferService.request({
      companyId: (req as any).user.companyId,
      fromBranchId,
      toBranchId,
      requestedBy: (req as any).user.userId,
      items,
      notes,
    });
    return res.status(201).json(transfer);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const transfers = await transferService.list((req as any).user.companyId, {
      branchId: req.query.branchId as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json({ transfers });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const transfer = await transferService.getById(req.params.id, (req as any).user.companyId);
    res.json(transfer);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

// Aprovação/rejeição/cancelamento — decisão gerencial, restrita.
router.post(
  '/:id/approve',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Transfer'),
  async (req: Request, res: Response) => {
    try {
      const transfer = await transferService.approve({
        transferId: req.params.id,
        companyId: (req as any).user.companyId,
        approvedBy: (req as any).user.userId,
      });
      return res.json(transfer);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

router.post(
  '/:id/reject',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Transfer'),
  async (req: Request, res: Response) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ error: 'reason é obrigatório' });
      }
      const transfer = await transferService.reject({
        transferId: req.params.id,
        companyId: (req as any).user.companyId,
        reason,
      });
      return res.json(transfer);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

// Envio — qualquer usuário autorizado da filial de origem (operacional).
router.post('/:id/send', requireStockWriter, auditLog(AuditAction.UPDATE, 'Transfer'), async (req: Request, res: Response) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items é obrigatório' });
    }
    const transfer = await transferService.send({
      transferId: req.params.id,
      companyId: (req as any).user.companyId,
      sentBy: (req as any).user.userId,
      items,
    });
    return res.json(transfer);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Recebimento — qualquer usuário autorizado da filial de destino.
router.post('/:id/receive', requireStockWriter, auditLog(AuditAction.UPDATE, 'Transfer'), async (req: Request, res: Response) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items é obrigatório' });
    }
    const transfer = await transferService.receive({
      transferId: req.params.id,
      companyId: (req as any).user.companyId,
      receivedBy: (req as any).user.userId,
      items,
    });
    return res.json(transfer);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.post(
  '/:id/cancel',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.UPDATE, 'Transfer'),
  async (req: Request, res: Response) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ error: 'reason é obrigatório' });
      }
      const transfer = await transferService.cancel({
        transferId: req.params.id,
        companyId: (req as any).user.companyId,
        reason,
      });
      return res.json(transfer);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
);

export default router;
