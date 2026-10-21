import { Router } from 'express';
import { CompanyService } from '../services/company.service';
import { createCompanySchema, updateCompanySchema } from '@ln-system/shared/validators';
import { validateData } from '@ln-system/shared/utils/validation';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();
const companyService = new CompanyService();

// Todas as rotas requerem autenticação de Super Admin. `tenantIsolation`
// aqui não restringe nada a mais para SUPER_ADMIN (bypass total já
// embutido nela) — mas é ela quem popula o contexto de RLS do Postgres
// (app.user_type='SUPER_ADMIN'); sem isso, as policies de RLS negavam por
// padrão mesmo para o Super Admin de verdade, porque a variável de sessão
// nunca era setada.
router.use(authMiddleware, requireSuperAdmin, tenantIsolation);

/**
 * GET /api/companies
 * Listar empresas
 */
router.get('/', async (_req, res, next) => {
  try {
    const companies = await companyService.findAll();
    res.json({ success: true, data: companies });
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/companies/:id
 * Buscar empresa por ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const company = await companyService.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ success: false, error: 'Empresa não encontrada' });
    }
    return res.json({ success: true, data: company });
  } catch (error: any) {
    next(error);
    return;
  }
});

/**
 * POST /api/companies
 * Criar empresa
 */
router.post('/', auditLog(AuditAction.CREATE, 'Company'), async (req, res, next) => {
  try {
    const data = validateData(createCompanySchema, req.body);
    const company = await companyService.create(data);
    res.status(201).json({ success: true, data: company });
  } catch (error: any) {
    next(error);
  }
});

/**
 * PUT /api/companies/:id
 * Atualizar empresa
 */
router.put('/:id', auditLog(AuditAction.UPDATE, 'Company'), async (req, res, next) => {
  try {
    const data = validateData(updateCompanySchema, req.body);
    const company = await companyService.update(req.params.id, data);
    res.json({ success: true, data: company });
  } catch (error: any) {
    next(error);
  }
});

/**
 * DELETE /api/companies/:id
 * Deletar empresa
 */
router.delete('/:id', auditLog(AuditAction.DELETE, 'Company'), async (req, res, next) => {
  try {
    await companyService.delete(req.params.id);
    res.json({ success: true, message: 'Empresa deletada com sucesso' });
  } catch (error: any) {
    if (error.message === 'Empresa não encontrada') {
      return res.status(404).json({ success: false, error: error.message });
    }
    if (error.message.startsWith('Não é possível excluir')) {
      return res.status(400).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

/**
 * POST /api/companies/:id/toggle-active
 * Ativar/Desativar empresa
 */
router.post('/:id/toggle-active', auditLog(AuditAction.UPDATE, 'Company'), async (req, res, next) => {
  try {
    const company = await companyService.toggleActive(req.params.id);
    res.json({ success: true, data: company });
  } catch (error: any) {
    if (error.message === 'Empresa não encontrada') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

export default router;
