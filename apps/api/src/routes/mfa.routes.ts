import { Router } from 'express';
import { mfaService } from '../services/MFAService';
import { rateLimitMFA } from '../middlewares/advancedRateLimit';
import { authMiddleware as authenticate } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { logger } from '../utils/logger';
import { auditLog } from '../middleware/audit';
import { prisma, AuditAction } from '@ln-system/database';
import { comparePassword } from '@ln-system/shared/utils/password';
import { sealSecret } from '@ln-system/shared/utils/secret-box';
import redis from '../config/redis';
import { consumeTotp, consumeBackupCode, regenerateBackupCodes } from '../services/mfa-factor.service';
import { mfaRequiredForUserType } from '../services/mfa-policy';

const router = Router();

// `tenantIsolation` é quem popula o contexto de Row-Level Security do
// Postgres (ver packages/database/rls-context.ts) a partir do req.user já
// autenticado — sem ele, toda query desta rota (todas fazem
// prisma.user.findUnique/update pelo próprio id do usuário logado) é
// negada pelas policies de RLS por padrão (fail closed), e a rota inteira
// quebrava com 500 genérico. `authenticate` sozinho nunca populava esse
// contexto; faltava aqui desde que o RLS foi ligado.
router.use(authenticate);
router.use(tenantIsolation);

// TTL do código de SMS/e-mail no Redis (mesma janela informada ao usuário).
const MFA_CODE_TTL_SECONDS = 10 * 60;

/**
 * @swagger
 * /api/mfa/setup:
 *   post:
 *     summary: Setup MFA for user
 *     tags: [MFA]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: MFA setup initiated
 *       401:
 *         description: Unauthorized
 */
router.post('/setup', auditLog(AuditAction.UPDATE, 'User'), async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const email = (req as any).user.email;

    // Com o MFA já ativo, sobrescrever o segredo trancava o dono para fora (o
    // login passa a exigir TOTP do segredo novo, que ele nunca viu) e deixava
    // quem tivesse só um access token roubado trocar o segundo fator. Para
    // trocar é preciso desativar antes — /disable exige a senha.
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true } });
    if (current?.mfaEnabled) {
      res.status(409).json({
        error: 'MFA já está ativo. Desative-o (com a sua senha) antes de configurar de novo.',
        code: 'MFA_ALREADY_ENABLED',
      });
      return;
    }

    const mfaData = mfaService.generateSecret(userId, email);

    // ANTES DESTA CORREÇÃO: o secret e os códigos de backup eram gerados e
    // devolvidos na resposta, mas NUNCA persistidos — o setup de MFA não
    // tinha efeito algum, e todo login subsequente com MFA "habilitado"
    // seria impossível de verificar. mfaEnabled só é ativado depois que o
    // usuário confirmar um código válido em /verify (evita ficar trancado
    // fora da conta por um QR code mal escaneado).
    const hashedBackupCodes = mfaData.backupCodes.map((c) => mfaService.hashBackupCode(c));

    await prisma.user.update({
      where: { id: userId },
      data: {
        // Cifrado em repouso (secret-box): o segredo TOTP é o segundo fator inteiro.
        mfaSecret: sealSecret(mfaData.secret),
        mfaBackupCodes: hashedBackupCodes,
        // mfaEnabled permanece false até a confirmação em /verify
      },
    });

    logger.info(`MFA setup initiated for user: ${userId}`);

    res.json({
      success: true,
      data: {
        secret: mfaData.secret,
        qrCode: mfaData.qrCode,
        // Códigos de backup em texto plano só existem neste momento —
        // depois disso só o hash fica armazenado. O usuário precisa salvá-los agora.
        backupCodes: mfaData.backupCodes,
      },
      message: 'Escaneie o QR code e confirme com um código em /api/mfa/verify para ativar o MFA.',
    });
  } catch (error) {
    logger.error('MFA setup error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to setup MFA',
    });
  }
});

/**
 * @swagger
 * /api/mfa/verify:
 *   post:
 *     summary: Verify MFA code (and activate MFA if setup was pending)
 *     tags: [MFA]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *             properties:
 *               code:
 *                 type: string
 *                 description: 6-digit TOTP code
 *     responses:
 *       200:
 *         description: Code verified
 *       400:
 *         description: Invalid code
 *       429:
 *         description: Too many attempts
 */
router.post('/verify', rateLimitMFA, async (req, res) => {
  try {
    const { code } = req.body;
    const userId = (req as any).user.userId;

    // ANTES: lia `(req as any).user.mfaSecret` — campo que nunca existe no
    // JWT (JwtPayload só tem userId/email/companyId/branchId/userType) —
    // fazendo esta rota falhar sempre com "MFA not configured".
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecret: true, mfaEnabled: true },
    });

    if (!user?.mfaSecret) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'MFA not configured for this user',
      });
    }

    // consumeTotp confere E consome: o mesmo código não vale duas vezes.
    const verification = await consumeTotp(userId, user.mfaSecret, code);

    if (verification.valid) {
      // Confirmação do setup: primeira verificação bem-sucedida ativa o MFA.
      if (!user.mfaEnabled) {
        await prisma.user.update({
          where: { id: userId },
          data: { mfaEnabled: true },
        });
        logger.info(`MFA activated for user: ${userId}`);
      }

      logger.info(`MFA verified for user: ${userId}`);
      return res.json({ success: true, message: 'Code verified successfully', mfaEnabled: true });
    } else {
      logger.warn(`MFA verification failed for user: ${userId}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid Code',
        message: verification.error || 'Invalid verification code',
      });
    }
  } catch (error) {
    logger.error('MFA verification error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify MFA code',
    });
  }
});

/**
 * @swagger
 * /api/mfa/verify-backup:
 *   post:
 *     summary: Verify MFA backup code
 *     tags: [MFA]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - backupCode
 *             properties:
 *               backupCode:
 *                 type: string
 *                 description: 16-character backup code
 *     responses:
 *       200:
 *         description: Backup code verified
 *       400:
 *         description: Invalid code
 */
router.post('/verify-backup', rateLimitMFA, async (req, res) => {
  try {
    const { backupCode } = req.body;
    const userId = (req as any).user.userId;

    // ANTES: lia `usedBackupCodes` de `req.user` (não existe no JWT) e
    // MFAService.verifyBackupCode só validava o FORMATO — qualquer código de
    // 16 caracteres passava. Agora comparamos contra os hashes realmente
    // emitidos e ainda não usados, armazenados no banco, e o consumo é ATÔMICO
    // (compare-and-swap da lista): duas requisições com o mesmo código não passam as duas.
    const verification = await consumeBackupCode(userId, backupCode);

    if (verification.valid) {
      logger.info(`MFA backup code verified for user: ${userId}`);

      res.json({
        success: true,
        message: 'Backup code verified successfully',
        warning: 'This backup code cannot be used again',
      });
    } else {
      logger.warn(`MFA backup code verification failed for user: ${userId}`);
      res.status(400).json({
        success: false,
        error: 'Invalid Code',
        message: verification.error || 'Invalid backup code',
      });
    }
  } catch (error) {
    logger.error('MFA backup verification error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify backup code',
    });
  }
});

/**
 * @swagger
 * /api/mfa/send-sms:
 *   post:
 *     summary: Send MFA code via SMS
 *     tags: [MFA]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: SMS sent
 *       429:
 *         description: Too many attempts
 */
router.post('/send-sms', rateLimitMFA, async (req, res) => {
  try {
    // MFAService.sendSMSCode só loga o código — não existe integração real
    // com nenhum provedor (Twilio/SNS/etc, ver MFAService.ts). Em produção,
    // "sucesso" aqui significa o código nunca chega ao usuário de verdade —
    // risco real de conta trancada. Falhar alto e claro em vez de fingir
    // que funcionou (TASK-004 do quadro de tarefas original; docs/CORTEX/SECURITY.md, "MFA").
    // Fora de produção, mantido funcional (devolve o código na resposta)
    // para permitir testar o restante do fluxo de MFA sem um provedor real.
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        success: false,
        error: 'Service Unavailable',
        message: 'Verificação por SMS não está disponível nesta instância — use o aplicativo autenticador (TOTP).',
      });
    }

    const userId = (req as any).user.userId;

    // ANTES: lia `phone` de `req.user`, campo inexistente no JWT — sempre
    // caía em "No phone number configured". Agora busca do banco.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });

    if (!user?.phone) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No phone number configured',
      });
    }

    const result = await mfaService.sendSMSCode(user.phone);

    if (result.success) {
      // O código gerado precisa ser guardado em algum lugar para a
      // verificação futura poder compará-lo — antes isso era um TODO nunca
      // implementado, então nenhum código de SMS/e-mail jamais podia ser
      // confirmado de verdade.
      if (result.code) {
        await redis.setex(`mfa:sms:${userId}`, MFA_CODE_TTL_SECONDS, result.code);
      }

      return res.json({
        success: true,
        message: 'SMS code sent successfully',
        ...(process.env.NODE_ENV === 'development' && result.code && { code: result.code }),
      });
    } else {
      return res.status(500).json({
        success: false,
        error: 'Failed to send SMS',
      });
    }
  } catch (error) {
    logger.error('SMS sending error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to send SMS',
    });
  }
});

/**
 * @swagger
 * /api/mfa/send-email:
 *   post:
 *     summary: Send MFA code via email
 *     tags: [MFA]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Email sent
 *       429:
 *         description: Too many attempts
 */
router.post('/send-email', rateLimitMFA, async (req, res) => {
  try {
    // Mesmo motivo de /send-sms acima — sem provedor real de e-mail
    // integrado (ver MFAService.ts).
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        success: false,
        error: 'Service Unavailable',
        message: 'Verificação por e-mail não está disponível nesta instância — use o aplicativo autenticador (TOTP).',
      });
    }

    const userId = (req as any).user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user?.email) {
      return res.status(400).json({ error: 'Bad Request', message: 'User email not found' });
    }

    const result = await mfaService.sendEmailCode(user.email);

    if (result.success) {
      if (result.code) {
        await redis.setex(`mfa:email:${userId}`, MFA_CODE_TTL_SECONDS, result.code);
      }

      return res.json({
        success: true,
        message: 'Email code sent successfully',
        ...(process.env.NODE_ENV === 'development' && result.code && { code: result.code }),
      });
    } else {
      return res.status(500).json({
        success: false,
        error: 'Failed to send email',
      });
    }
  } catch (error) {
    logger.error('Email sending error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to send email',
    });
  }
});

/**
 * Novos códigos de recuperação (os antigos deixam de valer). Exige a senha E um código TOTP válido; exibidos uma única vez.
 */
router.post(
  '/backup-codes/regenerate',
  rateLimitMFA,
  auditLog(AuditAction.UPDATE, 'UserMfa', { describe: (req) => ({ entityId: req.user!.userId, newValue: { operation: 'BACKUP_CODES_REGENERATED' } }) }),
  async (req, res) => {
    try {
      const { password, code } = req.body ?? {};
      const userId = (req as any).user.userId;
      if (typeof password !== 'string' || !password || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Bad Request', message: 'Informe a senha e o código de 6 dígitos do aplicativo.' });
      }
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
      if (!user || !(await comparePassword(password, user.password))) {
        return res.status(400).json({ error: 'Bad Request', message: 'Senha inválida' });
      }
      const result = await regenerateBackupCodes(userId, code);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true, data: result, message: 'Guarde os novos códigos agora: eles não serão mostrados de novo e os anteriores deixaram de valer.' });
    } catch (error: any) {
      if (error?.statusCode && error?.code) return res.status(error.statusCode).json({ error: error.code, message: error.message });
      logger.error('MFA backup codes regeneration error:', { error: error?.message });
      return res.status(500).json({ error: 'Internal Server Error', message: 'Falha ao gerar novos códigos' });
    }
  }
);

/**
 * @swagger
 * /api/mfa/disable:
 *   post:
 *     summary: Disable MFA for user
 *     tags: [MFA]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 description: User password for confirmation
 *     responses:
 *       200:
 *         description: MFA disabled
 *       400:
 *         description: Invalid password
 */
router.post('/disable', auditLog(AuditAction.UPDATE, 'User'), async (req, res) => {
  try {
    const { password } = req.body;
    const userId = (req as any).user.userId;

    if (!password) {
      return res.status(400).json({ error: 'Bad Request', message: 'Password is required' });
    }

    // ANTES: o comentário dizia "verify against stored password hash" mas
    // nunca fazia isso, e nunca persistia mfaEnabled=false — desabilitar MFA
    // não tinha nenhum efeito real e não exigia senha de fato.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { password: true, userType: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found' });
    }

    // Perfil com MFA obrigatório não desliga o próprio segundo fator (decisão 123): a recuperação é a reinicialização administrativa,
    // auditada, que derruba as sessões. Senão bastava o dono (ou quem roubasse a sessão e a senha) desligar a exigência.
    if (mfaRequiredForUserType(user.userType)) {
      return res.status(403).json({
        error: 'MFA_REQUIRED_FOR_ROLE',
        message: 'Este perfil exige a verificação em duas etapas e ela não pode ser desativada. Em caso de perda do aplicativo, peça a reinicialização ao administrador.',
      });
    }

    const passwordValid = await comparePassword(password, user.password);
    if (!passwordValid) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid password' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: false,
        mfaSecret: null,
        mfaBackupCodes: [],
      },
    });

    logger.info(`MFA disabled for user: ${userId}`);

    return res.json({
      success: true,
      message: 'MFA disabled successfully',
    });
  } catch (error) {
    logger.error('MFA disable error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to disable MFA',
    });
  }
});

export default router;
