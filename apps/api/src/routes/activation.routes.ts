import { canAccessBranch } from '../utils/branch-access';
import { Router } from 'express';
import activationService from '../services/activation.service';
import { authMiddleware, requireSuperAdmin, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { AuditAction, prisma } from '@ln-system/database';
import { forceEndDeviceSession } from '../services/device-session.service';
import { deviceEnrollmentService } from '../services/device-enrollment.service';

const router = Router();

// `tenantIsolation` popula o contexto de RLS (empresa do solicitante, ou
// bypass total para SUPER_ADMIN aprovando) — sem ela toda query a
// licenses/devices/activations era negada por padrão pelas policies.
router.use(authMiddleware, tenantIsolation);

/**
 * POST /api/activations/request
 * Solicitação de ativação de dispositivo — qualquer usuário autenticado da
 * empresa dona da licença pode solicitar (não precisa ser Super Admin: é o
 * app cliente rodando pela primeira vez). companyId nunca vem do corpo da
 * requisição — vem do usuário autenticado, e a licença é validada como
 * pertencente a essa mesma empresa antes de aceitar a solicitação.
 */
router.post('/request', async (req, res, next) => {
  try {
    const user = req.user!;
    const { licenseId, deviceName, deviceType, macAddress } = req.body;

    if (!licenseId || !deviceName || !deviceType) {
      return res.status(400).json({
        success: false,
        error: 'licenseId, deviceName e deviceType são obrigatórios',
      });
    }

    if (user.userType !== 'SUPER_ADMIN') {
      const license = await prisma.license.findUnique({ where: { id: licenseId }, select: { companyId: true } });
      if (!license || license.companyId !== user.companyId) {
        return res.status(403).json({ success: false, error: 'Licença não pertence à sua empresa' });
      }
    }

    const result = await activationService.requestActivation({
      licenseId,
      userId: user.userId,
      deviceName,
      deviceType,
      macAddress,
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      data: {
        deviceId: result.device.id,
        activationId: result.activation.id,
        activationCode: result.activation.activationCode,
        status: result.activation.status,
      },
      message: 'Solicitação registrada. Aguardando aprovação do Super ADM TI.',
    });
  } catch (error: any) {
    next(error);
    return;
  }
});

/**
 * GET /api/activations/pending — fila de análise (Super ADM TI)
 */
router.get('/pending', requireSuperAdmin, async (_req, res, next) => {
  try {
    const pending = await activationService.listPendingActivations();
    res.json({ success: true, data: pending });
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/activations/enrollments — equipamentos NOVOS aguardando autorização (enrolados por POST /api/device/enroll, ainda sem
 * empresa nem filial). O administrador compara o código curto mostrado na tela da máquina com este.
 */
router.get('/enrollments', requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ success: true, data: await deviceEnrollmentService.listPending() });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/activations/enrollments/:deviceId/authorize — o Super ADM TI VINCULA o equipamento a uma licença (empresa) e a uma
 * filial e o ativa. Quem escolhe empresa/filial é o administrador, nunca o equipamento nem o usuário. Gera auditoria.
 */
router.post('/enrollments/:deviceId/authorize', requireSuperAdmin, auditLog(AuditAction.UPDATE, 'Device'), async (req, res, next) => {
  try {
    const { licenseId, branchId, deviceName } = req.body ?? {};
    if (typeof licenseId !== 'string' || typeof branchId !== 'string' || !licenseId || !branchId) {
      return res.status(400).json({ success: false, error: 'licenseId e branchId são obrigatórios' });
    }
    if (deviceName !== undefined && typeof deviceName !== 'string') {
      return res.status(400).json({ success: false, error: 'deviceName deve ser texto' });
    }
    const device = await deviceEnrollmentService.authorize({ deviceId: req.params.deviceId, licenseId, branchId, deviceName, actorId: req.user!.userId });
    return res.json({ success: true, data: device });
  } catch (error: any) {
    next(error);
    return;
  }
});

/**
 * POST /api/activations/:id/approve — Super ADM TI aprova e emite a
 * credencial assinada do dispositivo.
 */
router.post(
  '/:id/approve',
  requireSuperAdmin,
  auditLog(AuditAction.UPDATE, 'Activation'),
  async (req, res) => {
    try {
      const result = await activationService.approveActivation(req.params.id, req.user!.userId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

/**
 * POST /api/activations/:id/reject — Super ADM TI rejeita.
 */
router.post(
  '/:id/reject',
  requireSuperAdmin,
  auditLog(AuditAction.UPDATE, 'Activation'),
  async (req, res) => {
    try {
      const { reason } = req.body;
      const result = await activationService.rejectActivation(req.params.id, req.user!.userId, reason);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

/**
 * GET /api/activations/devices — todos os dispositivos da plataforma
 * (Super ADM TI). Precisa vir ANTES de /devices/:licenseId na definição de
 * rotas para não ser capturada por esse parâmetro.
 *
 * Paginado (ver comentário em activationService.listAllDevices) — o
 * middleware global clampPaginationLimit só trava um `limit` que já veio na
 * query string; como esta rota nunca teve paginação nenhuma antes, era
 * inofensivo até o frontend passar a mandar page/limit de verdade.
 */
router.get('/devices', requireSuperAdmin, async (req, res, next) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const result = await activationService.listAllDevices({ page, limit });
    res.json({ success: true, data: result.devices, pagination: result.pagination });
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/activations/devices/:licenseId — dispositivos de uma licença
 */
// Equipamentos de uma licença: administração e gerência. O gerente vê só os da PRÓPRIA filial (+ os da empresa toda); a RLS de `devices` repete a regra.
router.get('/devices/:licenseId', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const user = req.user!;
    if (user.userType !== 'SUPER_ADMIN') {
      const license = await prisma.license.findUnique({
        where: { id: req.params.licenseId },
        select: { companyId: true },
      });
      if (!license || license.companyId !== user.companyId) {
        return res.status(403).json({ success: false, error: 'Licença não pertence à sua empresa' });
      }
    }

    const devices = await activationService.listDevicesByLicense(req.params.licenseId);
    return res.json({ success: true, data: devices });
  } catch (error: any) {
    next(error);
    return;
  }
});

/**
 * POST /api/activations/devices/:id/block — Super ADM TI bloqueia (reversível)
 */
router.post(
  '/devices/:id/block',
  requireSuperAdmin,
  auditLog(AuditAction.UPDATE, 'Device'),
  async (req, res) => {
    try {
      const { reason } = req.body;
      const device = await activationService.blockDevice(req.params.id, req.user!.userId, reason);
      res.json({ success: true, data: device });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

/**
 * POST /api/activations/devices/:id/unblock
 */
router.post(
  '/devices/:id/unblock',
  requireSuperAdmin,
  auditLog(AuditAction.UPDATE, 'Device'),
  async (req, res) => {
    try {
      const device = await activationService.unblockDevice(req.params.id);
      res.json({ success: true, data: device });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

/**
 * POST /api/activations/devices/:id/revoke — permanente
 */
router.post(
  '/devices/:id/revoke',
  requireSuperAdmin,
  auditLog(AuditAction.DELETE, 'Device'),
  async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ success: false, error: 'Motivo da revogação é obrigatório' });
      }
      const device = await activationService.revokeDevice(req.params.id, req.user!.userId, reason);
      return res.json({ success: true, data: device });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }
);

/**
 * POST /api/activations/devices/:id/force-end-session — encerra
 * administrativamente uma sessão de PDV travada (queda de energia, crash do
 * app cliente, etc. — situações em que /auth/logout nunca chegou a ser
 * chamado, então o índice único parcial "one_active_per_device" continua
 * segurando o equipamento como ocupado). Diferente de unblock/revoke acima
 * (que são ações de TI sobre o Device em si e exigem Super Admin), esta é
 * uma ação operacional do dia a dia da loja — por isso Gerente/Admin da
 * própria empresa já pode executá-la, não só Super Admin.
 */
router.post(
  '/devices/:id/force-end-session',
  requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'),
  auditLog(AuditAction.UPDATE, 'DeviceSession'),
  async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ success: false, error: 'Motivo do encerramento é obrigatório' });
      }

      const actingUser = req.user!;
      // Gerente só encerra a sessão de equipamento da PRÓPRIA filial: equipamento de outra filial é invisível para ele (RLS) e a recusa é explícita.
      if (actingUser.userType === 'MANAGER') {
        const device = await prisma.device.findUnique({ where: { id: req.params.id }, select: { id: true, branchId: true } });
        if (!device) {
          return res.status(404).json({ success: false, error: 'Equipamento não encontrado' });
        }
        if (!canAccessBranch(actingUser, device.branchId)) {
          return res.status(403).json({ success: false, error: 'Você só encerra sessões de equipamentos das filiais às quais está vinculado', code: 'BRANCH_FORBIDDEN' });
        }
      }
      const actor = await prisma.user.findUnique({
        where: { id: actingUser.userId },
        select: { name: true, companyId: true },
      });
      if (!actor) {
        return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
      }

      // Para SUPER_ADMIN (sem companyId próprio), a empresa é determinada
      // pelo próprio dispositivo — nunca aceita do corpo da requisição.
      let targetCompanyId = actor.companyId;
      if (!targetCompanyId) {
        const device = await prisma.device.findUnique({
          where: { id: req.params.id },
          select: { license: { select: { companyId: true } } },
        });
        if (!device) {
          return res.status(404).json({ success: false, error: 'Equipamento não encontrado' });
        }
        if (!device.license) {
          return res.status(409).json({ success: false, error: 'Equipamento ainda não foi autorizado (sem empresa)' });
        }
        targetCompanyId = device.license.companyId;
      }

      const session = await forceEndDeviceSession({
        deviceId: req.params.id,
        endedByUserId: actingUser.userId,
        endedByName: actor.name,
        reason,
        companyId: targetCompanyId!,
      });

      return res.json({ success: true, data: session });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }
);

/**
 * POST /api/activations/devices/:id/heartbeat — chamado periodicamente
 * pelo app cliente já ativo (PDV/Balcão/Android) para sinalizar atividade.
 */
router.post('/devices/:id/heartbeat', async (req, res) => {
  try {
    const user = (req as any).user;
    const device = await activationService.recordHeartbeat(req.params.id, req.ip, user.userType === 'SUPER_ADMIN' ? undefined : user.companyId);
    res.json({ success: true, data: { lastSeenAt: device.lastSeenAt } });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

export default router;
