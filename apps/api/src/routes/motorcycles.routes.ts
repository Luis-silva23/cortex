import { Router, Request, Response, NextFunction } from 'express';
import motorcycleService from '../services/motorcycle.service';
import { motorcycleSchema, updateMotorcycleSchema } from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await motorcycleService.list({
      companyId: (req as any).user.companyId,
      customerId: req.query.customerId as string,
      search: req.query.search as string,
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
    const motorcycle = await motorcycleService.getById(req.params.id, (req as any).user.companyId);
    if (!motorcycle) {
      return res.status(404).json({ error: 'Motorcycle not found' });
    }
    return res.json(motorcycle);
  } catch (error: any) {
    return next(error);
  }
});

// Moto é cadastro do cliente — mesma regra de customers.routes.ts: quem recebe o cliente no balcão/oficina cadastra;
// editar/excluir é da gerência. VIEWER nunca escreve.
router.post('/', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'), auditLog(AuditAction.CREATE, 'Motorcycle'), async (req: Request, res: Response) => {
  try {
    const data = motorcycleSchema.parse(req.body);
    const motorcycle = await motorcycleService.create({
      ...data,
      companyId: (req as any).user.companyId,
      licensePlate: data.licensePlate ?? undefined,
      chassisNumber: data.chassisNumber ?? undefined,
      color: data.color ?? undefined,
      engineNumber: data.engineNumber ?? undefined,
      year: data.year ?? undefined,
    });
    res.status(201).json(motorcycle);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'));

router.put('/:id', auditLog(AuditAction.UPDATE, 'Motorcycle'), async (req: Request, res: Response) => {
  try {
    const data = updateMotorcycleSchema.parse(req.body);
    const motorcycle = await motorcycleService.update(req.params.id, (req as any).user.companyId, data);
    res.json(motorcycle);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'Motorcycle'), async (req: Request, res: Response) => {
  try {
    await motorcycleService.deactivate(req.params.id, (req as any).user.companyId);
    res.json({ message: 'Motorcycle deactivated successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
