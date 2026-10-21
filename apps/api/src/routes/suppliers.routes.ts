import { Router, Request, Response, NextFunction } from 'express';
import supplierService from '../services/supplier.service';
import { supplierSchema, updateSupplierSchema } from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { routeErrorMessage } from '../utils/route-error';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await supplierService.list({
      companyId: (req as any).user.companyId,
      search: req.query.search as string,
      isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
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
    const supplier = await supplierService.getById(req.params.id, (req as any).user.companyId);
    if (!supplier) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    return res.json(supplier);
  } catch (error: any) {
    return next(error);
  }
});

// ACHADO DE AUDITORIA: criar/editar/desativar fornecedor não tinha NENHUMA
// trava de papel — qualquer usuário autenticado do tenant (inclusive
// OPERATOR/MECHANIC) podia reescrever dado cadastral real de um fornecedor
// (CNPJ, endereço, contato/pagamento) usado depois por Compras/Financeiro
// ao gerar pedidos de compra e contas a pagar, ou desativá-lo. Mesmo padrão
// já usado em partners.routes.ts (GET aberto para qualquer usuário do
// tenant — uso operacional legítimo, ex.: buscar fornecedor ao criar um
// pedido de compra — mas escrita restrita a Gerência+).
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'));

router.post('/', auditLog(AuditAction.CREATE, 'Supplier'), async (req: Request, res: Response) => {
  try {
    const data = supplierSchema.parse(req.body);
    const supplier = await supplierService.create({
      ...data,
      companyId: (req as any).user.companyId,
      tradeName: data.tradeName ?? undefined,
      email: data.email ?? undefined,
      phone: data.phone ?? undefined,
      mobile: data.mobile ?? undefined,
      address: data.address ?? undefined,
      addressNumber: data.addressNumber ?? undefined,
      addressComplement: data.addressComplement ?? undefined,
      city: data.city ?? undefined,
      state: data.state ?? undefined,
      zipCode: data.zipCode ?? undefined,
      notes: data.notes ?? undefined,
    });
    res.status(201).json(supplier);
  } catch (error: any) {
    res.status(400).json({ error: routeErrorMessage(error, { unique: 'Já existe um fornecedor com este documento', fallback: 'Não foi possível salvar o fornecedor' }) });
  }
});

router.put('/:id', auditLog(AuditAction.UPDATE, 'Supplier'), async (req: Request, res: Response) => {
  try {
    const data = updateSupplierSchema.parse(req.body);
    const supplier = await supplierService.update(req.params.id, (req as any).user.companyId, data);
    res.json(supplier);
  } catch (error: any) {
    res.status(400).json({ error: routeErrorMessage(error, { unique: 'Já existe um fornecedor com este documento', fallback: 'Não foi possível salvar o fornecedor' }) });
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'Supplier'), async (req: Request, res: Response) => {
  try {
    await supplierService.deactivate(req.params.id, (req as any).user.companyId);
    res.json({ message: 'Supplier deactivated successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
