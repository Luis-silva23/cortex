import { Router } from 'express';
import partnerService from '../services/partner.service';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { authorizedBranchIds, canAccessBranch } from '../utils/branch-access';

const router = Router();

const isCompanyWide = (user: { userType?: string }) => user.userType === 'SUPER_ADMIN' || user.userType === 'COMPANY_ADMIN';

/**
 * Escopo de ESCRITA do convênio (regra de acesso por filial): acesso empresarial grava convênio da empresa toda ou de qualquer filial DA empresa
 * (a filial é validada no service); o GERENTE grava só convênio da PRÓPRIA filial — não cria, edita, ativa nem apaga o da empresa toda nem o de outra filial.
 * A RLS (`partners_insert/update/delete`) repete a regra. Devolve a mensagem de recusa, ou null se pode.
 */
function branchWriteDenied(user: { userType?: string; branchId?: string | null; branchIds?: string[] }, targetBranchId: string | null | undefined, requestedBranchId?: string | null): { status: number; code: string; message: string } | null {
  if (isCompanyWide(user)) return null;
  // filiais AUTORIZADAS do gerente: a principal + os vínculos (calculadas no servidor; decisão 153)
  const allowed = authorizedBranchIds(user) ?? [];
  if (allowed.length === 0) return { status: 403, code: 'BRANCH_REQUIRED', message: 'Seu usuário não está vinculado a uma filial' };
  if (!targetBranchId || !allowed.includes(targetBranchId)) return { status: 403, code: 'BRANCH_FORBIDDEN', message: 'Você só altera convênios das filiais às quais está vinculado' };
  if (requestedBranchId !== undefined && (!requestedBranchId || !allowed.includes(requestedBranchId))) return { status: 403, code: 'BRANCH_FORBIDDEN', message: 'Você só pode vincular convênios às filiais às quais está vinculado' };
  return null;
}

// Convênios/parceiros alimentam o desconto da venda: pertencem ao módulo VENDAS
// (discount-rules e installment-policies, do mesmo assunto, já tinham o gate).
router.use(authMiddleware, tenantIsolation, requireModuleEnabled('VENDAS'));

router.get('/', async (req, res, next) => {
  try {
    const requestedBranch = typeof req.query.branchId === 'string' && req.query.branchId ? req.query.branchId : undefined;
    // pedir o filtro de uma filial que não é dele não é "lista vazia": é 403 (e a RLS limita o que existiria)
    if (requestedBranch && !canAccessBranch((req as any).user, requestedBranch)) {
      return res.status(403).json({ success: false, error: 'Você só consulta as filiais às quais está vinculado', code: 'BRANCH_FORBIDDEN' });
    }
    const partners = await partnerService.list((req as any).user.companyId, requestedBranch);
    return res.json({ success: true, data: partners });
  } catch (error: any) {
    return next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const partner = await partnerService.getById(req.params.id, (req as any).user.companyId);
    if (!partner) {
      return res.status(404).json({ success: false, error: 'Convênio não encontrado' });
    }
    return res.json({ success: true, data: partner });
  } catch (error: any) {
    return next(error);
  }
});

// Só quem pode configurar regras de negócio (mesmo critério de
// discount-rules.routes.ts/commission-rules.routes.ts).
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'));

router.post('/', auditLog(AuditAction.CREATE, 'Partner'), async (req, res) => {
  try {
    const companyId = (req as any).user.companyId;
    const user = (req as any).user;
    const { name, description, discountType, discountValue, maxDiscountAmount, stackable, requiresApproval, validFrom, validUntil } = req.body;
    if (!name || discountValue === undefined || discountValue === null) {
      return res.status(400).json({ success: false, error: 'name e discountValue são obrigatórios' });
    }
    // gerente: o convênio nasce na filial dele (omitir a filial = a própria; outra filial = 403)
    const requestedBranch = req.body.branchId ?? (isCompanyWide(user) ? undefined : user.branchId);
    const denied = branchWriteDenied(user, requestedBranch ?? null, requestedBranch ?? null);
    if (denied) return res.status(denied.status).json({ success: false, error: denied.message, code: denied.code });
    const partner = await partnerService.create({
      companyId,
      branchId: requestedBranch,
      name,
      description,
      discountType,
      discountValue: Number(discountValue),
      maxDiscountAmount: maxDiscountAmount != null ? Number(maxDiscountAmount) : null,
      stackable,
      requiresApproval,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
    });
    return res.status(201).json({ success: true, data: partner });
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

router.put('/:id', auditLog(AuditAction.UPDATE, 'Partner'), async (req, res) => {
  try {
    const companyId = (req as any).user.companyId;
    // ACHADO DE AUDITORIA (PRE-PRODUCTION HARDENING, Backend/API): esta rota
    // fazia `const data: any = { ...req.body }` — um "mass assignment" que
    // deixava passar QUALQUER campo do corpo da requisição direto para
    // `prisma.partner.update()`, inclusive `companyId` (um COMPANY_ADMIN
    // conseguia, em tese, tentar reatribuir um Partner da própria empresa
    // para OUTRA empresa via PUT). Confirmado ao vivo (script descartável,
    // não commitado): a tentativa realmente chegava ao Postgres — só não
    // causava dano porque a política de RLS de `partners` tem `WITH CHECK`
    // (nunca permite que a linha resultante pertença a uma empresa
    // diferente da sessão), rejeitando com um erro 42501. Mas isso expunha
    // o erro CRU do Prisma/Postgres (caminho de arquivo interno, stack)
    // direto no corpo da resposta 400 — RLS é a rede de segurança, não uma
    // desculpa para aceitar campo nenhum sem filtro. Corrigido: allowlist
    // explícita dos campos editáveis, mesmo padrão já usado no POST desta
    // mesma rota.
    const body = req.body ?? {};
    const actor = (req as any).user;
    const current = await partnerService.getById(req.params.id, companyId);
    if (!current) return res.status(404).json({ success: false, error: 'Convênio não encontrado' });
    const deniedPut = branchWriteDenied(actor, current.branchId, body.branchId);
    if (deniedPut) return res.status(deniedPut.status).json({ success: false, error: deniedPut.message, code: deniedPut.code });
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description;
    if (body.branchId !== undefined) data.branchId = body.branchId;
    if (body.discountType !== undefined) data.discountType = body.discountType;
    if (body.discountValue !== undefined) data.discountValue = Number(body.discountValue);
    if (body.maxDiscountAmount !== undefined) data.maxDiscountAmount = body.maxDiscountAmount != null ? Number(body.maxDiscountAmount) : null;
    if (body.stackable !== undefined) data.stackable = Boolean(body.stackable);
    if (body.requiresApproval !== undefined) data.requiresApproval = Boolean(body.requiresApproval);
    if (body.validFrom !== undefined) data.validFrom = body.validFrom ? new Date(body.validFrom) : null;
    if (body.validUntil !== undefined) data.validUntil = body.validUntil ? new Date(body.validUntil) : null;
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    const partner = await partnerService.update(req.params.id, companyId, data as any);
    return res.json({ success: true, data: partner });
  } catch (error: any) {
    if (error.message === 'Convênio não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return res.status(400).json({ success: false, error: error.message });
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'Partner'), async (req, res, next) => {
  try {
    const current = await partnerService.getById(req.params.id, (req as any).user.companyId);
    if (!current) return res.status(404).json({ success: false, error: 'Convênio não encontrado' });
    const denied = branchWriteDenied((req as any).user, current.branchId);
    if (denied) return res.status(denied.status).json({ success: false, error: denied.message, code: denied.code });
    await partnerService.delete(req.params.id, (req as any).user.companyId);
    res.json({ success: true, message: 'Convênio excluído com sucesso' });
  } catch (error: any) {
    if (error.message === 'Convênio não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

router.post('/:id/toggle-active', auditLog(AuditAction.UPDATE, 'Partner'), async (req, res, next) => {
  try {
    const current = await partnerService.getById(req.params.id, (req as any).user.companyId);
    if (!current) return res.status(404).json({ success: false, error: 'Convênio não encontrado' });
    const denied = branchWriteDenied((req as any).user, current.branchId);
    if (denied) return res.status(denied.status).json({ success: false, error: denied.message, code: denied.code });
    const partner = await partnerService.toggleActive(req.params.id, (req as any).user.companyId);
    res.json({ success: true, data: partner });
  } catch (error: any) {
    if (error.message === 'Convênio não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

export default router;
