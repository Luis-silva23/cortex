import { Router, Request, Response } from 'express';
import categoryService from '../services/category.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);

// GET aberto a qualquer usuário autenticado do tenant — precisa popular o
// <select> de categoria nas telas de criar/editar produto, usadas por
// qualquer operador (mesmo padrão de products/suppliers/partners: leitura
// operacional, escrita restrita).
router.get('/', async (req: Request, res: Response) => {
  try {
    const categories = await categoryService.list((req as any).user.companyId);
    res.json(categories);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const category = await categoryService.getById(req.params.id, (req as any).user.companyId);
    res.json(category);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

// Escrita restrita a Gerência+ — mesmo padrão já usado em
// products/suppliers/partners/commission-rules nesta sessão.
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'));

router.post('/', auditLog(AuditAction.CREATE, 'Category'), async (req: Request, res: Response) => {
  try {
    const { name, description, parentId } = req.body;
    const category = await categoryService.create({
      companyId: (req as any).user.companyId,
      name,
      description,
      parentId,
    });
    res.status(201).json(category);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/:id', auditLog(AuditAction.UPDATE, 'Category'), async (req: Request, res: Response) => {
  try {
    const { name, description, parentId, isActive } = req.body;
    const category = await categoryService.update(req.params.id, (req as any).user.companyId, {
      name,
      description,
      parentId,
      isActive,
    });
    res.json(category);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'Category'), async (req: Request, res: Response) => {
  try {
    await categoryService.deactivate(req.params.id, (req as any).user.companyId);
    res.json({ message: 'Category deactivated successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
