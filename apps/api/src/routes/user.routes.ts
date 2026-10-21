import { Router } from 'express';
import { UserService } from '../services/user.service';
import roleService from '../services/role.service';
import { createUserSchema, updateUserSchema, resetPasswordSchema } from '@ln-system/shared/validators';
import { validateData } from '@ln-system/shared/utils/validation';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction, prisma } from '@ln-system/database';
import { comparePassword } from '@ln-system/shared/utils/password';
import { rateLimitAuthorizer } from '../middlewares/advancedRateLimit';
import { resetFactor } from '../services/mfa-factor.service';
import { AppError } from '@ln-system/shared';
import type { UserType } from '@ln-system/shared/types';
import { getUserPermissions } from '../middleware/permission';
import { resolveWriteBranchId } from '../utils/branch-context';
import { getBranchLinks, setBranchLinks } from '../services/user-branch.service';

const router = Router();
const userService = new UserService();

// Todas as rotas requerem autenticação + contexto de RLS. Antes desta
// correção, só `GET /` tinha `tenantIsolation` — POST/PUT/DELETE/
// toggle-active (criar, atualizar, excluir, ativar/desativar usuário)
// rodavam SEM nenhum contexto de RLS ativo, então toda escrita na tabela
// `users` era negada por padrão (fail-closed) desde que a RLS entrou em
// vigor na FASE 1 — confirmado em teste real desta sessão (FASE 27): criar
// um usuário MECHANIC via API sempre falhava com "a nova linha viola a
// política de segurança". Mesma classe de bug já encontrada e corrigida em
// outros arquivos de rota nas FASES 5/6 (mfa/company/license/activation/
// observability/branch/backup/auth), só que esta ocorrência nunca havia
// sido exercitada por um teste real até agora.
router.use(authMiddleware);
router.use(tenantIsolation);

const USER_TYPES: readonly UserType[] = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER'];

// Filtros opcionais da listagem. Valor inválido é 400 (e não "ignora o filtro"):
// devolver a lista inteira para um `userType=MECANICO` digitado errado faria
// quem chama achar que recebeu só mecânicos.
function parseListFilters(query: Record<string, unknown>): { userType?: UserType; isActive?: boolean } {
  const filters: { userType?: UserType; isActive?: boolean } = {};

  if (query.userType !== undefined) {
    const value = query.userType;
    if (typeof value !== 'string' || !USER_TYPES.includes(value as UserType)) {
      throw new AppError(`userType inválido. Use um de: ${USER_TYPES.join(', ')}`, 400, 'VALIDATION_ERROR');
    }
    filters.userType = value as UserType;
  }

  if (query.isActive !== undefined) {
    if (query.isActive !== 'true' && query.isActive !== 'false') {
      throw new AppError('isActive inválido. Use true ou false', 400, 'VALIDATION_ERROR');
    }
    filters.isActive = query.isActive === 'true';
  }

  return filters;
}

// Diretório de usuários: quem administra (SUPER_ADMIN/COMPANY_ADMIN/MANAGER) vê
// o cadastro completo (e-mail, telefone, `numericId` — que é login e código de
// autorizador —, MFA, último acesso). Os demais papéis só precisam de "quem é"
// (ex.: o seletor de mecânico da OS) e recebem id, nome, perfil e situação —
// antes QUALQUER papel listava os dados pessoais e de segurança dos colegas.
const DIRECTORY_ADMIN_TYPES: readonly string[] = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'];

function toDirectoryEntry(target: any) {
  return { id: target.id, name: target.name, userType: target.userType, isActive: target.isActive };
}

/**
 * GET /api/users
 * Listar usuários (filtros opcionais: `userType`, `isActive`)
 */
router.get('/', async (req, res, next) => {
  try {
    const user = req.user!;

    // Super Admin vê todos, outros veem apenas da própria empresa
    const companyId = user.userType === 'SUPER_ADMIN' ? undefined : user.companyId;
    const page = req.query.page ? parseInt(req.query.page as string) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const result = await userService.findAll(companyId, { page, limit }, parseListFilters(req.query));

    const data = DIRECTORY_ADMIN_TYPES.includes(user.userType) ? result.users : result.users.map(toDirectoryEntry);
    res.json({ success: true, data, pagination: result.pagination });
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/users/:id
 * Buscar usuário por ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const foundUser = await userService.findById(req.params.id);
    
    if (!foundUser) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    // Validar acesso tenant
    const user = req.user!;
    if (user.userType !== 'SUPER_ADMIN' && foundUser.companyId !== user.companyId) {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }

    // O próprio registro é completo; o de outra pessoa, só para gerência+ (senão, enxuto).
    const canSeeFull = DIRECTORY_ADMIN_TYPES.includes(user.userType) || foundUser.id === user.userId;
    return res.json({ success: true, data: canSeeFull ? foundUser : toDirectoryEntry(foundUser) });
  } catch (error: any) {
    return next(error);
  }
});

/**
 * POST /api/users
 * Criar usuário
 */
router.post('/', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'), auditLog(AuditAction.CREATE, 'User'), async (req, res, next) => {
  try {
    const data = validateData(createUserSchema, req.body);

    // CRÍTICO (achado de auditoria, 2026-09-14): `createUserSchema` aceita
    // `userType` como qualquer valor do enum, incluindo SUPER_ADMIN — e
    // nada aqui restringia isso. Um COMPANY_ADMIN (que passa no
    // `requireUserType` acima) podia criar um usuário com
    // `userType: 'SUPER_ADMIN'` e ganhar uma conta com acesso à
    // PLATAFORMA INTEIRA, sem limite de companyId — mesma classe do bug
    // de escalação de privilégio já corrigido nesta sessão para
    // assignRoleToUser/backup, só que por um caminho diferente (criação
    // de usuário, não atribuição de role). Só quem já é SUPER_ADMIN pode
    // criar outro SUPER_ADMIN.
    if (data.userType === 'SUPER_ADMIN' && req.user!.userType !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, error: 'Apenas um Super Admin pode criar outro Super Admin' });
    }

    // Se não for Super Admin, forçar companyId do usuário logado
    if (req.user!.userType !== 'SUPER_ADMIN') {
      data.companyId = req.user!.companyId;
    } else if (data.userType !== 'SUPER_ADMIN' && !data.companyId) {
      // Achado (sonda real): SUPER_ADMIN criando OPERATOR/MANAGER... sem companyId
      // gravava um usuário de empresa SEM empresa (órfão, que nem consegue logar).
      // Só o SUPER_ADMIN é da plataforma; os demais precisam de um alvo explícito.
      return res.status(400).json({
        success: false,
        code: 'COMPANY_CONTEXT_REQUIRED',
        error: 'companyId é obrigatório para criar usuário de empresa',
      });
    }

    // Filial do novo usuário tem de ser da empresa dele (a FK de users.branchId aceita filial de outra empresa).
    const branchId = await resolveWriteBranchId({ companyId: data.companyId, branchId: req.user!.branchId }, data.branchId);
    const user = await userService.create({
      ...data,
      branchId,
      userType: data.userType as UserType,
    });
    return res.status(201).json({ success: true, data: user });
  } catch (error: any) {
    return next(error);
  }
});

/**
 * PUT /api/users/:id
 * Atualizar usuário
 */
router.put('/:id', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'), auditLog(AuditAction.UPDATE, 'User'), async (req, res, next) => {
  try {
    const data = validateData(updateUserSchema, req.body);

    // CRÍTICO — mesmo achado do POST acima, só que mais direto aqui: sem
    // esta checagem um COMPANY_ADMIN podia promover QUALQUER usuário da
    // própria empresa (inclusive a si mesmo) a SUPER_ADMIN com uma única
    // chamada PUT, sem precisar nem criar um usuário novo.
    if (data.userType === 'SUPER_ADMIN' && req.user!.userType !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, error: 'Apenas um Super Admin pode promover alguém a Super Admin' });
    }

    // Ninguém muda o PRÓPRIO perfil (nem para escapar de uma exigência de MFA, nem para se promover): outra pessoa autorizada faz.
    if (data.userType && req.params.id === req.user!.userId && data.userType !== req.user!.userType) {
      return res.status(403).json({ success: false, error: 'Não é permitido alterar o próprio perfil de acesso', code: 'SELF_ROLE_CHANGE' });
    }

    const companyId = req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
    const user = await userService.update(req.params.id, data, companyId);
    res.json({ success: true, data: user });
  } catch (error: any) {
    if (error.message === 'Usuário não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

/**
 * DELETE /api/users/:id
 * Deletar usuário
 */
router.delete('/:id', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'), auditLog(AuditAction.DELETE, 'User'), async (req, res, next) => {
  try {
    const companyId = req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
    await userService.delete(req.params.id, companyId);
    res.json({ success: true, message: 'Usuário deletado com sucesso' });
  } catch (error: any) {
    if (error.message === 'Usuário não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

/**
 * POST /api/users/:id/unlock
 * Desbloquear usuário travado por tentativas de login inválidas
 */
router.post('/:id/unlock', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'), auditLog(AuditAction.UPDATE, 'User'), async (req, res, next) => {
  try {
    const companyId = req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
    const user = await userService.unlock(req.params.id, companyId);
    res.json({ success: true, data: user });
  } catch (error: any) {
    if (error.message === 'Usuário não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

/**
 * POST /api/users/:id/reset-password
 * Redefinir senha de um usuário (ação administrativa)
 */
router.post('/:id/reset-password', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'), auditLog(AuditAction.UPDATE, 'User'), async (req, res, next) => {
  try {
    const { password, requirePasswordChange } = validateData(resetPasswordSchema, req.body);
    const companyId = req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
    const user = await userService.resetPassword(req.params.id, password, companyId, requirePasswordChange ?? true);
    res.json({ success: true, data: user });
  } catch (error: any) {
    if (error.message === 'Usuário não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

/**
 * POST /api/users/:id/toggle-active
 * Ativar/Desativar usuário
 */
router.post('/:id/toggle-active', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'), auditLog(AuditAction.UPDATE, 'User'), async (req, res, next) => {
  try {
    const companyId = req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
    const user = await userService.toggleActive(req.params.id, companyId);
    res.json({ success: true, data: user });
  } catch (error: any) {
    if (error.message === 'Usuário não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

/**
 * POST /api/users/:id/mfa/reset
 * RECUPERAÇÃO CONTROLADA do segundo fator (perda do aplicativo autenticador): só SUPER_ADMIN, com a PRÓPRIA senha e um motivo.
 * Apaga segredo e códigos de recuperação do alvo e derruba todas as sessões dele; quem tem perfil com MFA obrigatório configura de
 * novo no próximo login. Auditado (autor, alvo, motivo) sem nenhum segredo. Não se aplica a si mesmo (use o procedimento de TI).
 */
router.post('/:id/mfa/reset', requireUserType('SUPER_ADMIN'), rateLimitAuthorizer,
  auditLog(AuditAction.UPDATE, 'UserMfa', {
    describe: (req) => ({ entityId: req.params.id, newValue: { operation: 'MFA_RESET', targetUserId: req.params.id, reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null } }),
  }),
  async (req, res, next) => {
  try {
    const { password, reason } = req.body ?? {};
    if (typeof password !== 'string' || !password || typeof reason !== 'string' || reason.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Informe a sua senha e o motivo (mínimo de 5 caracteres).', code: 'MFA_RESET_FIELDS_REQUIRED' });
    }
    if (req.params.id === req.user!.userId) {
      return res.status(403).json({ success: false, error: 'Não é possível reiniciar o próprio fator por aqui: use o procedimento administrativo de TI.', code: 'MFA_RESET_SELF' });
    }
    const actor = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { password: true, isActive: true } });
    if (!actor?.isActive || !(await comparePassword(password, actor.password))) {
      return res.status(401).json({ success: false, error: 'Senha incorreta.', code: 'WRONG_PASSWORD' });
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!target) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    await resetFactor(target.id);
    return res.json({ success: true, message: 'Verificação em duas etapas reiniciada. A pessoa precisará configurá-la de novo no próximo acesso e as sessões dela foram encerradas.' });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/users/:id/branches
 * Filiais AUTORIZADAS do usuário: a principal (`users.branchId`) + os vínculos adicionais (`user_branches`). Só a administração da empresa
 * (SUPER_ADMIN/COMPANY_ADMIN) ou o próprio usuário — um gerente não lista os vínculos de um colega.
 */
router.get('/:id/branches', async (req, res, next) => {
  try {
    const me = req.user!;
    if (!['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(me.userType) && req.params.id !== me.userId) {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }
    return res.json({ success: true, data: await getBranchLinks(me, req.params.id) });
  } catch (error) {
    return next(error);
  }
});

/**
 * PUT /api/users/:id/branches   { "branchIds": ["<filial>", ...] }
 * Define, por completo, as filiais ADICIONAIS do usuário de filial (gerente de várias filiais). Só SUPER_ADMIN/COMPANY_ADMIN; filiais da MESMA empresa
 * do usuário; o que sai da lista perde o acesso na requisição seguinte (decisão 153). Auditado (quem concedeu/retirou e quais filiais).
 */
router.put(
  '/:id/branches',
  requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.UPDATE, 'User', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: { vinculosDeFilial: { adicionados: body?.data?.added ?? [], removidos: body?.data?.removed ?? [], filiaisAdicionais: body?.data?.extraBranchIds ?? [] } },
    }),
  }),
  async (req, res, next) => {
    try {
      return res.json({ success: true, data: await setBranchLinks(req.user!, req.params.id, req.body?.branchIds) });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * GET /api/users/:id/roles
 * Listar perfis (RBAC) atribuídos a um usuário
 */
router.get('/:id/roles', async (req, res, next) => {
  try {
    // Perfis e permissões de um colega são informação de administração: só
    // gerência+ (ou o próprio usuário, para a Sidebar/tela de segurança).
    if (!DIRECTORY_ADMIN_TYPES.includes(req.user!.userType) && req.params.id !== req.user!.userId) {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }
    const companyId = req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
    const roles = await roleService.listUserRoles(req.params.id, companyId);
    res.json({ success: true, data: roles });
  } catch (error: any) {
    if (error.message === 'Usuário não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

/**
 * GET /api/users/:id/permissions
 * Permissões efetivas de um usuário (resultado de todos os perfis atribuídos)
 */
router.get('/:id/permissions', async (req, res, next) => {
  try {
    const requester = req.user!;
    // ACHADO DE AUDITORIA (achado adjacente, corrigido ao consumir este
    // endpoint pela primeira vez no frontend — Sidebar): só faltava o
    // isolamento por empresa, então qualquer usuário autenticado do tenant
    // podia listar as permissões de QUALQUER outro colega de empresa
    // informando o id — nunca escalava privilégio (é leitura), mas era
    // exposição de informação desnecessária. Agora só o próprio usuário
    // (para a Sidebar/UI saber o que mostrar) ou um admin podem consultar.
    const isSelf = requester.userId === req.params.id;
    const isAdmin = requester.userType === 'SUPER_ADMIN' || requester.userType === 'COMPANY_ADMIN' || requester.userType === 'MANAGER';
    if (!isSelf && !isAdmin) {
      return res.status(403).json({ success: false, error: 'Você só pode consultar suas próprias permissões' });
    }

    const companyId = requester.userType === 'SUPER_ADMIN' ? undefined : requester.companyId;
    const target = await userService.findById(req.params.id);
    if (!target || (companyId && target.companyId !== companyId)) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }
    const permissions = await getUserPermissions(req.params.id, target.companyId ?? undefined);
    return res.json({ success: true, data: permissions });
  } catch (error: any) {
    return next(error);
  }
});

/**
 * POST /api/users/:id/roles
 * Atribuir um perfil (RBAC) a um usuário, opcionalmente restrito a uma filial
 */
router.post('/:id/roles', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  // PERMISSION_CHANGED com o que mudou: autor = userId do token; alvo = :id; escopo = filial (null = empresa toda).
  auditLog(AuditAction.PERMISSION_CHANGED, 'User', {
    describe: (req) => ({ entityId: req.params.id, newValue: { operation: 'ROLE_ASSIGNED', targetUserId: req.params.id, roleId: req.body?.roleId ?? null, branchId: req.body?.branchId ?? null } }),
  }),
  async (req, res, next) => {
  try {
    const { roleId, branchId } = req.body;
    if (!roleId) {
      return res.status(400).json({ success: false, error: 'roleId é obrigatório' });
    }
    const companyId = req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
    await roleService.assignRoleToUser(req.params.id, roleId, branchId ?? null, companyId, req.user!.userId);
    return res.status(201).json({ success: true });
  } catch (error: any) {
    if (['Usuário não encontrado', 'Perfil não encontrado', 'Filial não encontrada nesta empresa', 'Não é permitido atribuir um perfil a si mesmo'].includes(error.message)) {
      return res.status(400).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

/**
 * DELETE /api/users/:id/roles/:roleId
 * Revogar um perfil de um usuário (?branchId= quando o vínculo foi restrito a uma filial)
 */
router.delete('/:id/roles/:roleId', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN'),
  auditLog(AuditAction.PERMISSION_CHANGED, 'User', {
    describe: (req) => ({ entityId: req.params.id, newValue: { operation: 'ROLE_REVOKED', targetUserId: req.params.id, roleId: req.params.roleId, branchId: (req.query.branchId as string) || null } }),
  }),
  async (req, res, next) => {
  try {
    const companyId = req.user!.userType === 'SUPER_ADMIN' ? undefined : req.user!.companyId;
    const branchId = (req.query.branchId as string) || null;
    await roleService.revokeRoleFromUser(req.params.id, req.params.roleId, branchId, companyId);
    return res.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Usuário não encontrado') {
      return res.status(404).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

export default router;
