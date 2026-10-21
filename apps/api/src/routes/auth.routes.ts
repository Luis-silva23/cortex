import { Router } from 'express';
import { AuthService, MfaEnrollmentRequiredError, MfaEnrollmentRefusedError, PasswordChangeRequiredError, PasswordChangeError } from '../services/auth.service';
import { rateLimitAuth, rateLimitMFA, rateLimitAuthorizer } from '../middlewares/advancedRateLimit';
import { comparePassword } from '@ln-system/shared/utils/password';
import { logger } from '../utils/logger';
import { createAuditLog } from '../middleware/audit';
import { authMiddleware } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { AuditAction, prisma, runWithRLSContext } from '@ln-system/database';
import { DeviceSessionError, DeviceAuthError } from '../services/device-session.service';
import { revokeAccessToken } from '../services/access-token-revocation';
import { verifyAccessToken } from '@ln-system/shared/utils/token';
import { hashRefreshToken } from '../services/refresh-token-hash';
import { isDatabaseUnavailableError } from '../middleware/errorHandler';
import { DATABASE_UNAVAILABLE_MESSAGE } from '../middleware/translate-errors';

const router = Router();
const authService = new AuthService();

/**
 * ANTES DESTA REESCRITA: todo este arquivo era um stub de demonstração.
 * `/login` nunca consultava o banco — usava um usuário hardcoded que
 * aceitava a senha literal "senha123" para QUALQUER e-mail, com um segredo
 * TOTP fixo (`JBSWY3DPEHPK3PXP`) compartilhado por "todo mundo". `/verify-mfa`
 * aceitava o código "123456" fixo para SMS/e-mail. Os tokens eram assinados
 * inline com `process.env.JWT_SECRET || 'secret'` (reintroduzindo o fallback
 * inseguro já removido de shared/utils/token.ts) e nem sequer incluíam
 * companyId/branchId/userType — quebrando toda checagem de tenant/permissão
 * downstream. Era, na prática, um bypass de autenticação completo.
 *
 * AuthService (já correto: busca real no banco, hash de senha, bloqueio por
 * tentativas, refresh token com rotação) existia mas nunca era chamado por
 * nenhuma rota. Esta reescrita conecta as rotas ao serviço real.
 */

// Tentativa de login recusada: o identificador tentado e o motivo (nunca a senha). A empresa do usuário, quando o
// e-mail/ID existe, deixa o admin da empresa ver ataques às contas dela; identificador inexistente fica só para o SA.
async function recordFailedLogin(req: any, reason: string) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : undefined;
  const numericId = req.body?.numericId !== undefined && req.body?.numericId !== '' ? Number(req.body.numericId) : undefined;
  const user = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () =>
    email || (numericId !== undefined && !Number.isNaN(numericId))
      ? await prisma.user.findFirst({
          where: email ? { email } : { numericId },
          select: { id: true, companyId: true },
        })
      : null
  );
  await createAuditLog({
    companyId: user?.companyId ?? null,
    userId: null,
    action: AuditAction.LOGIN_FAILED,
    entity: 'User',
    entityId: user?.id ?? null,
    newValue: JSON.stringify({ identifier: email ?? numericId ?? null, reason }),
    ipAddress: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers?.['user-agent'] || null,
  });
}

router.post('/login', rateLimitAuth, async (req, res) => {
  try {
    // Admin Web / Super Admin autenticam por e-mail; PDV e Balcão/Oficina
    // usam o ID numérico de 6 dígitos (mais rápido de digitar em balcão).
    const { email, password } = req.body ?? {};
    const numericId =
      req.body?.numericId !== undefined && req.body.numericId !== null && req.body.numericId !== ''
        ? Number(req.body.numericId)
        : undefined;

    // Fronteira: e-mail e senha são texto. Objeto/array ({"$ne":null}, ["a"]) viraria erro interno (500) no banco/bcrypt.
    if ((email !== undefined && typeof email !== 'string') || (password !== undefined && typeof password !== 'string')) {
      return res.status(400).json({ error: 'Bad Request', message: 'Email (ou numericId) and password must be text' });
    }

    if ((!email && (numericId === undefined || Number.isNaN(numericId))) || !password) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Email (ou numericId) and password are required',
      });
    }

    const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.slice(0, 100) : undefined;
    const deviceKey = typeof req.body.deviceKey === 'string' ? req.body.deviceKey.slice(0, 200) : undefined;
    const result = await authService.login({ email, numericId, password, deviceId, deviceKey }, req.ip, req.headers['user-agent']);

    if ('mfaRequired' in result) {
      logger.info('MFA required for login', { email, numericId });
      return res.json({ success: true, ...result, message: 'Please provide MFA code' });
    }

    logger.info('Successful login', { userId: result.user.id });

    createAuditLog({
      companyId: result.user.companyId || null,
      userId: result.user.id,
      action: AuditAction.LOGIN,
      entity: 'User',
      entityId: result.user.id,
      newValue: null,
      ipAddress: req.ip || req.socket.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
    }).catch((error) => {
      logger.error('Failed to write login audit log', { error });
    });

    return res.json({ success: true, ...result });
  } catch (error: any) {
    // Banco indisponível não é falha de credencial: não conta como tentativa falha, não grava LOGIN_FAILED e devolve o mesmo
    // contrato que a tradução de erros já entregava (503 + Retry-After). Antes o texto do Prisma, que traz o trecho do
    // código-fonte com 'Credenciais inválidas', casava a regex abaixo e a queda do banco era tratada como credencial errada.
    if (isDatabaseUnavailableError(error)) {
      logger.warn('Login indisponível: banco de dados', { code: error?.code });
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: DATABASE_UNAVAILABLE_MESSAGE, code: 'DATABASE_UNAVAILABLE' });
    }
    logger.warn('Failed login attempt', { email: req.body?.email, numericId: req.body?.numericId, error: error.message });
    // Mensagens de erro de negócio (credenciais inválidas, conta bloqueada/
    // desativada) voltam como 401; qualquer outra coisa é erro interno.
    if (error instanceof DeviceSessionError) {
      return res.status(409).json({ error: error.code, message: error.message });
    }
    // Equipamento não autorizado (pendente/desconhecido/bloqueado/revogado/chave errada/outra filial): 403 com o código, SEM dado
    // algum de empresa. Só chega aqui quem já acertou a senha. Fica registrado em segurança.
    if (error instanceof DeviceAuthError) {
      logger.warn('Login negado: equipamento não autorizado', { code: error.code, ip: req.ip });
      res.locals.notAGuess = true; // a senha estava certa: não conta como tentativa de adivinhar credencial no limitador por IP
      return res.status(403).json({ error: error.code, message: error.message });
    }
    // Senha temporária (decisão 157): 403 com a credencial de 10 min que só abre /auth/password-change/complete (só chega aqui quem acertou a senha).
    if (error instanceof PasswordChangeRequiredError) {
      res.locals.notAGuess = true;
      return res.status(403).json({ error: error.code, message: error.message, passwordChangeToken: error.passwordChangeToken });
    }
    // Conta privilegiada sem MFA: 403 com código estável (só chega aqui quem acertou a senha; não é tentativa de adivinhar).
    if (error instanceof MfaEnrollmentRequiredError) {
      res.locals.notAGuess = true;
      // COMPANY_ADMIN recebe a credencial de configuração (10 min, só abre /auth/mfa-enrollment/*); SUPER_ADMIN, nada além do código.
      return res.status(403).json({ error: error.code, message: error.message, ...(error.enrollmentToken ? { enrollmentToken: error.enrollmentToken } : {}) });
    }
    // Empresa bloqueada pelo Super Admin: 403 (não é problema de credencial — o cliente
    // mostra a mensagem em vez de tratar como sessão expirada).
    if (/Empresa desativada/.test(error.message)) {
      return res.status(403).json({ error: 'Forbidden', message: error.message });
    }
    // Erro do Prisma nunca é "credencial inválida": a mensagem dele cita trechos do código-fonte.
    const knownError = !/^PrismaClient/.test(String(error?.name ?? '')) && /Credenciais inválidas|Conta desativada|Conta bloqueada/.test(error.message);
    if (knownError) {
      recordFailedLogin(req, error.message).catch((auditError) => logger.error('Failed to write failed-login audit', { auditError }));
    }
    return res.status(knownError ? 401 : 500).json({
      error: knownError ? 'Unauthorized' : 'Internal Server Error',
      message: knownError ? error.message : 'Failed to process login',
    });
  }
});

router.post('/verify-mfa', rateLimitMFA, async (req, res) => {
  try {
    const { mfaToken, code, method = 'totp' } = req.body;

    if (!mfaToken || !code) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'MFA token and code are required',
      });
    }

    if (!['totp', 'backup', 'sms', 'email'].includes(method)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid MFA method' });
    }

    const result = await authService.verifyMfaAndCompleteLogin(
      mfaToken,
      code,
      method,
      req.ip,
      req.headers['user-agent']
    );

    logger.info('MFA verified successfully', { userId: result.user.id, method });

    createAuditLog({
      companyId: result.user.companyId || null,
      userId: result.user.id,
      action: AuditAction.LOGIN,
      entity: 'User',
      entityId: result.user.id,
      newValue: JSON.stringify({ mfa: method }),
      ipAddress: req.ip || req.socket.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
    }).catch((error) => logger.error('Failed to write MFA login audit log', { error }));

    return res.json({ success: true, ...result, message: 'Login successful' });
  } catch (error: any) {
    if (error instanceof DeviceSessionError) {
      return res.status(409).json({ error: error.code, message: error.message });
    }
    if (error instanceof DeviceAuthError) {
      return res.status(403).json({ error: error.code, message: error.message });
    }
    // Senha temporária e MFA já confirmado: a sessão só sai depois da troca de senha.
    if (error instanceof PasswordChangeRequiredError) {
      return res.status(403).json({ error: error.code, message: error.message, passwordChangeToken: error.passwordChangeToken });
    }
    logger.warn('MFA verification failed', { error: error.message });
    const isTokenError = /token/i.test(error.message);
    return res.status(isTokenError ? 401 : 400).json({
      error: isTokenError ? 'Unauthorized' : 'Invalid Code',
      message: error.message || 'The provided MFA code is invalid',
    });
  }
});

/**
 * Enrolamento do MFA pela tela (decisão 123; COMPANY_ADMIN). Credencial = `enrollmentToken` devolvida pelo login (403
 * MFA_ENROLLMENT_REQUIRED) depois da senha correta. begin → segredo + URI do QR (única vez em que o segredo sai); confirm → código
 * válido ativa o MFA, devolve os códigos de recuperação (única exibição) e a sessão. Nada disso vai para o log nem para a auditoria.
 */
const enrollmentError = (error: any, res: any) => {
  if (error instanceof PasswordChangeRequiredError) return res.status(403).json({ error: error.code, message: error.message, passwordChangeToken: error.passwordChangeToken });
  if (error instanceof MfaEnrollmentRefusedError) return res.status(403).json({ error: error.code, message: error.message });
  if (error?.statusCode && error?.code) return res.status(error.statusCode).json({ error: error.code, message: error.message });
  if (/token/i.test(String(error?.message)) || /^(JsonWebTokenError|TokenExpiredError|NotBeforeError)$/.test(String(error?.name))) return res.status(401).json({ error: 'Unauthorized', message: 'A configuração expirou. Entre novamente com e-mail e senha.' });
  logger.error('MFA enrollment error', { error: error?.message });
  return res.status(500).json({ error: 'Internal Server Error', message: 'Não foi possível configurar a verificação em duas etapas.' });
};

router.post('/mfa-enrollment/begin', rateLimitMFA, async (req, res) => {
  try {
    const { enrollmentToken } = req.body ?? {};
    if (typeof enrollmentToken !== 'string' || !enrollmentToken) return res.status(400).json({ error: 'Bad Request', message: 'Informe a credencial de configuração recebida no login.' });
    const data = await authService.beginMfaEnrollment(enrollmentToken);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, data });
  } catch (error) {
    return enrollmentError(error, res);
  }
});

router.post('/mfa-enrollment/confirm', rateLimitMFA, async (req, res) => {
  try {
    const { enrollmentToken, code } = req.body ?? {};
    if (typeof enrollmentToken !== 'string' || !enrollmentToken || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Bad Request', message: 'enrollmentToken e um código de 6 dígitos são obrigatórios' });
    }
    const result = await authService.completeMfaEnrollment(enrollmentToken, code, req.ip, req.headers['user-agent']);
    createAuditLog({
      companyId: result.user.companyId || null,
      userId: result.user.id,
      action: AuditAction.UPDATE,
      entity: 'UserMfa',
      entityId: result.user.id,
      newValue: JSON.stringify({ operation: 'MFA_ENROLLED', via: 'login-enrollment' }),
      ipAddress: req.ip || req.socket.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
    }).catch((auditError) => logger.error('Failed to write MFA enrollment audit log', { auditError }));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, ...result, message: 'Verificação em duas etapas ativada' });
  } catch (error) {
    return enrollmentError(error, res);
  }
});

/**
 * TROCA DE SENHA (decisão 157). Dois caminhos, ambos exigem a SENHA ATUAL e aplicam a política de `password-policy.ts`:
 *  - /password-change/complete: primeiro acesso (senha temporária). Credencial = `passwordChangeToken` devolvido pelo login (403 PASSWORD_CHANGE_REQUIRED). Não emite sessão.
 *  - /change-password: troca voluntária, com sessão. Encerra todas as sessões da conta (inclusive esta): a pessoa entra de novo com a senha nova.
 * Nenhuma senha vai para log nem para auditoria.
 */
const passwordChangeError = (error: any, res: any) => {
  if (error instanceof PasswordChangeError) return res.status(error.statusCode).json({ error: error.code, message: error.message });
  if (isDatabaseUnavailableError(error)) {
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: DATABASE_UNAVAILABLE_MESSAGE, code: 'DATABASE_UNAVAILABLE' });
  }
  if (/token/i.test(String(error?.message)) || /^(JsonWebTokenError|TokenExpiredError|NotBeforeError)$/.test(String(error?.name))) {
    return res.status(401).json({ error: 'Unauthorized', message: 'A credencial de troca de senha é inválida ou expirou. Entre novamente.' });
  }
  logger.error('Password change error', { error: error?.message });
  return res.status(500).json({ error: 'Internal Server Error', message: 'Não foi possível trocar a senha.' });
};

const auditPasswordChange = (req: any, who: { userId: string; companyId: string | null }, via: string) =>
  createAuditLog({
    companyId: who.companyId,
    userId: who.userId,
    action: AuditAction.UPDATE,
    entity: 'User',
    entityId: who.userId,
    newValue: JSON.stringify({ operation: 'PASSWORD_CHANGED', via }),
    ipAddress: req.ip || req.socket.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
  }).catch((auditError) => logger.error('Failed to write password change audit log', { auditError }));

router.post('/password-change/complete', rateLimitAuth, async (req, res) => {
  try {
    const { passwordChangeToken, currentPassword, newPassword } = req.body ?? {};
    if (typeof passwordChangeToken !== 'string' || !passwordChangeToken || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'passwordChangeToken, currentPassword e newPassword são obrigatórios' });
    }
    const who = await authService.completePasswordChange(passwordChangeToken, currentPassword, newPassword, req.ip);
    auditPasswordChange(req, who, 'first-access');
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, message: 'Senha trocada. Entre com a nova senha.' });
  } catch (error) {
    return passwordChangeError(error, res);
  }
});

router.post('/change-password', rateLimitAuth, authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'currentPassword e newPassword são obrigatórios' });
    }
    const who = await authService.changeOwnPassword(req.user!.userId, currentPassword, newPassword, req.ip);
    auditPasswordChange(req, who, 'self-service');
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, message: 'Senha trocada. Entre novamente com a nova senha.' });
  } catch (error) {
    return passwordChangeError(error, res);
  }
});

router.post('/send-mfa-code', rateLimitMFA, async (req, res) => {
  try {
    const { mfaToken, method } = req.body;

    if (!mfaToken || !method || !['sms', 'email'].includes(method)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'MFA token and a valid method (sms|email) are required',
      });
    }

    const result = await authService.sendLoginMfaCode(mfaToken, method);

    if (result.success) {
      logger.info('MFA code sent', { method });
      return res.json({ success: true, message: `MFA code sent via ${method}` });
    } else {
      return res.status(500).json({
        error: 'Failed to send code',
        message: `Could not send MFA code via ${method}`,
      });
    }
  } catch (error: any) {
    logger.warn('Send MFA code error:', error.message);
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired MFA token' });
  }
});

/**
 * GET /me — usuário autenticado atual. Antes desta rota, o único jeito de um
 * cliente saber quem está logado (userType/companyId/branchId/nome) era
 * decodificar o próprio JWT no frontend — funcional para exibição, mas
 * nenhuma autorização real deve depender disso (o backend já valida tudo
 * via authMiddleware/requireUserType em cada rota; este endpoint é só uma
 * forma oficial e íntegra de o cliente ler os mesmos dados).
 */
// `/me` é a única rota deste arquivo com usuário JÁ autenticado consultando
// seus PRÓPRIOS dados — diferente de /login, /refresh, /logout, /verify-mfa
// (pré-tenant, sem sessão ainda), aqui é o caso normal: precisa do
// contexto real de RLS (empresa do usuário), não do bypass usado nos
// outros. `tenantIsolation` só nesta rota, não no router inteiro (as
// outras precisam continuar sem ele).
router.get('/me', authMiddleware, tenantIsolation, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        numericId: true,
        name: true,
        email: true,
        phone: true,
        userType: true,
        companyId: true,
        branchId: true,
        mfaEnabled: true,
        company: { select: { id: true, name: true, document: true, phone: true } },
        branch: { select: { id: true, name: true, address: true, phone: true } },
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    return res.json({ success: true, data: user });
  } catch (error: any) {
    return next(error);
  }
});

/**
 * Reautenticação (tela bloqueada do PDV Desktop): confere a SENHA do usuário que já tem sessão válida, sem criar sessão nova,
 * sem rotacionar token e sem efeito colateral — só responde se a senha confere. Existe para que "bloquear a tela" exija a
 * identidade de novo sem sair da conta (o que perderia a venda em andamento). Regras:
 *  - exige access token válido (authMiddleware) e confere SÓ o usuário do token: não há campo de identificador, então não dá
 *    para usar a sessão de um para validar a senha de outro;
 *  - tentativas erradas contam no balde `authorizer` do usuário (3 por 5 min, depois bloqueio), igual à segunda autorização;
 *  - a falha é auditada (LOGIN_FAILED, motivo `reauth_failed`) — a senha nunca vai para log nem auditoria.
 */
router.post('/reauthenticate', authMiddleware, tenantIsolation, rateLimitAuthorizer, async (req, res, next) => {
  try {
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
      return res.status(400).json({ error: 'Bad Request', message: 'Informe a senha.', code: 'PASSWORD_REQUIRED' });
    }
    const userId = req.user!.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, isActive: true, companyId: true },
    });
    const ok = !!user && user.isActive && (await comparePassword(password, user.password));
    if (!ok) {
      await createAuditLog({
        companyId: user?.companyId ?? null,
        userId: null,
        action: AuditAction.LOGIN_FAILED,
        entity: 'User',
        entityId: userId,
        newValue: JSON.stringify({ reason: 'reauth_failed' }),
        ipAddress: req.ip || req.socket?.remoteAddress || null,
        userAgent: req.headers?.['user-agent'] || null,
      });
      return res.status(401).json({ error: 'Unauthorized', message: 'Senha incorreta.', code: 'WRONG_PASSWORD' });
    }
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Refresh token — existia como método pronto em AuthService mas nunca tinha
 * um endpoint HTTP. Sem isso, não havia como um cliente renovar o access
 * token (15min de validade) sem fazer login de novo com senha.
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Bad Request', message: 'refreshToken is required' });
    }

    const result = await authService.refreshToken(refreshToken);

    return res.json({ success: true, ...result });
  } catch (error: any) {
    logger.warn('Refresh token error:', error.message);
    return res.status(401).json({ error: 'Unauthorized', message: error.message || 'Invalid refresh token', ...(error instanceof MfaEnrollmentRequiredError ? { code: error.code } : {}) });
  }
});

/**
 * Logout — mesma situação do /refresh: AuthService.logout() já existia e
 * revoga o refresh token no banco, mas não havia rota alguma o expondo.
 */
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Bad Request', message: 'refreshToken is required' });
    }

    // Buscar o usuário dono do refresh token antes de revogá-lo, apenas
    // para poder registrar o log de auditoria (esta rota não é autenticada
    // por JWT, então não há req.user disponível, nem contexto de empresa
    // para o RLS — mesmo bypass pré-tenant usado em auth.service.ts,
    // sempre restrito por `where: { token }`/`{ id }` de uma única linha).
    //
    // Duas consultas SEPARADAS de propósito, não um `select: { user: {...} }`
    // aninhado: o Prisma otimiza relações carregadas via `select` aninhado
    // com um "dataloader" interno que agrupa a consulta relacionada usando
    // `WHERE id IN (...)` — esse agrupamento roda por fora do
    // `$transaction([...])` que a extensão de RLS usa para aplicar
    // `SET LOCAL`, então a tabela relacionada (`users`) ficava sem
    // contexto e a RLS a negava (confirmado: "Inconsistent query result:
    // Field user is required to return data, got null instead").
    const { tokenRecord, companyId } = await runWithRLSContext(
      { companyId: null, userType: 'SUPER_ADMIN', branchId: null },
      async () => {
        const token = await prisma.refreshToken.findUnique({
          where: { tokenHash: hashRefreshToken(refreshToken) },
          select: { userId: true },
        });
        if (!token) return { tokenRecord: null, companyId: null };
        const user = await prisma.user.findUnique({
          where: { id: token.userId },
          select: { companyId: true },
        });
        return { tokenRecord: token, companyId: user?.companyId ?? null };
      }
    );

    await authService.logout(refreshToken);

    // O access token de quem saiu também deixa de valer (senão seguia aceito até expirar).
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.substring(7) : null;
    if (bearer) {
      let exp: number | undefined;
      try {
        exp = (verifyAccessToken(bearer) as { exp?: number }).exp;
      } catch {
        // token inválido/expirado: nada a revogar
      }
      if (exp) {
        try {
          await revokeAccessToken(bearer, exp);
        } catch (error) {
          // O refresh token já foi revogado (a sessão não renova); só o access token, de vida curta, segue valendo até expirar.
          // Falha de infraestrutura NÃO é silenciada: fica no log de segurança.
          logger.error('LOGOUT_ACCESS_TOKEN_NOT_REVOKED: o access token do logout não pôde ser revogado (Redis e PostgreSQL indisponíveis)', {
            error: (error as Error).message,
          });
        }
      }
    }

    if (tokenRecord) {
      createAuditLog({
        companyId: companyId,
        userId: tokenRecord.userId,
        action: AuditAction.LOGOUT,
        entity: 'User',
        entityId: tokenRecord.userId,
        newValue: null,
        ipAddress: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
      }).catch((error) => {
        logger.error('Failed to write logout audit log', { error });
      });
    }

    return res.json({ success: true, message: 'Logout successful' });
  } catch (error: any) {
    logger.error('Logout error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to process logout' });
  }
});

export default router;
