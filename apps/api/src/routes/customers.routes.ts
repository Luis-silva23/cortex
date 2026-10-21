import { Router, Request, Response } from 'express';
import customerService from '../services/customer.service';
import { customerSchema, updateCustomerSchema, customerSearchSchema } from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';

const router = Router();

// ACHADO DE AUDITORIA: um erro de validação virava um blob JSON do Zod no
// toast do PDV, e um conflito na unique [companyId, document] devolvia o erro
// cru do Prisma (com o caminho do arquivo do servidor no corpo). Mantém o
// status 400 de sempre — só a mensagem muda, para algo que o operador de
// balcão consiga ler e que não expõe detalhes internos.
// Recusas de regra do cadastro (CPF/CNPJ inválido 400, duplicado 409, contato preferencial incoerente 400) mantêm o
// corpo `{ error }` que PDV e Admin Web já leem, com o `code` ao lado.
function sendCustomerError(res: Response, error: any) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  if (error?.code === 'P2002') {
    return res.status(409).json({ error: 'Já existe cliente com este CPF/CNPJ nesta empresa.', code: 'CUSTOMER_DOCUMENT_DUPLICATE' });
  }
  return res.status(400).json({ error: customerErrorMessage(error) });
}

function customerErrorMessage(error: any): string {
  if (error?.name === 'ZodError' && Array.isArray(error.issues)) {
    return error.issues
      .map((issue: any) => (issue.path?.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
  }
  if (error?.code === 'P2002') {
    return 'Customer with this document already exists';
  }
  if (error?.name === 'PrismaClientKnownRequestError' || error?.name === 'PrismaClientValidationError') {
    return 'Não foi possível salvar o cliente';
  }
  return error?.message ?? 'Erro ao salvar cliente';
}

router.use(authMiddleware);
router.use(tenantIsolation);

// Busca rápida (para PDV)
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { search, limit } = customerSearchSchema.parse({
      search: req.query.search,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
    });

    const companyId = (req as any).user.companyId;
    const customers = await customerService.searchCustomers(companyId, search, limit);

    res.json({ customers });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Listar clientes
router.get('/', async (req: Request, res: Response) => {
  try {
    const filters = {
      companyId: (req as any).user.companyId,
      search: req.query.search as string,
      isActive: req.query.isActive ? req.query.isActive === 'true' : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    };

    const result = await customerService.listCustomers(filters);

    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Buscar cliente por ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;

    const customer = await customerService.getCustomerById(id, companyId);

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    return res.json(customer);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Estatísticas do cliente
router.get('/:id/stats', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;

    const stats = await customerService.getCustomerStats(id, companyId);

    res.json(stats);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA: nenhuma trava de papel existia em nenhum write deste
// arquivo — inclusive VIEWER (papel só-leitura por definição em todo o
// resto do sistema) conseguia criar/editar/apagar cliente. Diferente de
// suppliers/products/partners (nunca tocados por operador de PDV), CRIAR
// cliente É um fluxo real e legítimo do PDV: CustomerSearchModal.tsx
// (pdv-desktop) chama createCustomer() durante o cadastro de cliente
// avulso no balcão — restringir a criação a Gerência+ quebraria esse fluxo
// (violaria "não remova funcionalidades existentes"). Por isso aqui a
// trava exclui SÓ o VIEWER, diferente do padrão Gerência+ usado nos outros
// módulos. Editar/apagar cliente já são usados SOMENTE pelo admin-web
// (telas de backoffice) — sem chamador real no PDV/oficina — então esses
// dois recebem o mesmo padrão Gerência+ já estabelecido nesta sessão.
router.post(
  '/',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'),
  auditLog(AuditAction.CREATE, 'Customer'),
  async (req: Request, res: Response) => {
    try {
      const data = customerSchema.parse({
        ...req.body,
        companyId: (req as any).user.companyId,
      });

      // Dígito do CPF/CNPJ, duplicidade por dígitos e coerência do contato preferencial: customer.service.
      const customer = await customerService.createCustomer(data);

      return res.status(201).json(customer);
    } catch (error: any) {
      return sendCustomerError(res, error);
    }
  }
);

// Atualizar cliente — só admin-web chama (nenhum uso real em PDV/oficina).
router.put(
  '/:id',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'),
  auditLog(AuditAction.UPDATE, 'Customer'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const companyId = (req as any).user.companyId;
      const data = updateCustomerSchema.parse(req.body);

      const customer = await customerService.updateCustomer(id, companyId, data);

      res.json(customer);
    } catch (error: any) {
      sendCustomerError(res, error);
    }
  }
);

// Deletar cliente (soft delete) — só admin-web chama (nenhum uso real em PDV/oficina).
router.delete(
  '/:id',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'),
  auditLog(AuditAction.DELETE, 'Customer'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const companyId = (req as any).user.companyId;

      await customerService.deleteCustomer(id, companyId);

      res.json({ message: 'Customer deleted successfully' });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
);

export default router;
