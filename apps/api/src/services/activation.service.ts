import { prisma, runInTransaction } from '@ln-system/database';
import * as crypto from 'crypto';
import { generateDeviceCredential } from '@ln-system/shared/utils/token';
import { AppError, ConflictError } from '@ln-system/shared';
import { deviceEnrollmentService } from './device-enrollment.service';

/**
 * Fluxo (conforme documentado pelo usuário):
 * Solicitação de ativação -> código -> identificação do dispositivo ->
 * empresa -> filial -> tipo de aplicativo -> análise -> aprovação do
 * Super ADM TI -> credencial assinada -> dispositivo ativado.
 *
 * Um código de ativação sozinho NUNCA autoriza a instalação — só a
 * aprovação manual do Super ADM TI gera a credencial.
 */
export class ActivationService {
  /**
   * Passo 1: o app cliente solicita ativação. Cria o Device (PENDING) e a
   * Activation (PENDING) com um código único. Não autoriza nada ainda.
   */
  async requestActivation(data: {
    licenseId: string;
    userId: string;
    deviceName: string;
    deviceType: 'DESKTOP' | 'TABLET' | 'MOBILE' | 'POS';
    macAddress?: string;
    ipAddress?: string;
  }) {
    const license = await prisma.license.findUnique({
      where: { id: data.licenseId },
      include: { _count: { select: { devices: true } } },
    });

    // Recusas de regra de negócio com status próprio: como Error genérico a rota respondia 500 (e logava "Critical").
    if (!license) {
      throw new AppError('Licença não encontrada', 404, 'LICENSE_NOT_FOUND');
    }

    if (license.status !== 'ACTIVE') {
      throw new ConflictError('Licença não está ativa — não é possível solicitar ativação de dispositivo', 'LICENSE_NOT_ACTIVE');
    }

    // Respeitar o limite de dispositivos contratado na licença. Só conta
    // dispositivos que não foram revogados (um dispositivo revogado libera
    // a vaga para outro).
    const activeDeviceCount = await prisma.device.count({
      where: {
        licenseId: data.licenseId,
        status: { in: ['PENDING', 'ACTIVE', 'BLOCKED'] },
      },
    });

    if (activeDeviceCount >= license.maxDevices) {
      throw new ConflictError(
        `Limite de dispositivos atingido (${license.maxDevices}). Revogue um dispositivo existente antes de solicitar um novo.`
      );
    }

    const activationCode = crypto.randomBytes(6).toString('hex').toUpperCase();

    return await runInTransaction(async (tx) => {
      const device = await tx.device.create({
        data: {
          licenseId: data.licenseId,
          deviceName: data.deviceName,
          deviceType: data.deviceType,
          status: 'PENDING',
          macAddress: data.macAddress,
          ipAddress: data.ipAddress,
        },
      });

      const activation = await tx.activation.create({
        data: {
          licenseId: data.licenseId,
          deviceId: device.id,
          userId: data.userId,
          activationCode,
          status: 'PENDING',
          ipAddress: data.ipAddress,
        },
      });

      return { device, activation };
    });
  }

  /**
   * Listar solicitações pendentes (fila de análise do Super ADM TI)
   */
  async listPendingActivations() {
    return await prisma.activation.findMany({
      where: { status: 'PENDING' },
      include: {
        device: true,
        license: { include: { company: { select: { id: true, name: true } } } },
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { activatedAt: 'asc' },
    });
  }

  /**
   * Passo 2: Super ADM TI aprova. Só aqui o dispositivo vira ACTIVE e uma
   * credencial assinada é emitida — nunca antes disso.
   */
  async approveActivation(activationId: string, approvedBy: string) {
    const activation = await prisma.activation.findUnique({
      where: { id: activationId },
      include: { device: true, license: true },
    });

    if (!activation) {
      throw new Error('Solicitação de ativação não encontrada');
    }

    if (activation.status !== 'PENDING') {
      throw new Error(`Solicitação já foi ${activation.status === 'APPROVED' ? 'aprovada' : 'rejeitada'}`);
    }

    const now = new Date();

    const result = await runInTransaction(async (tx) => {
      // Duas aprovações simultâneas: só a primeira encontra a solicitação PENDING.
      const claimed = await tx.activation.updateMany({
        where: { id: activationId, status: 'PENDING' },
        data: { status: 'APPROVED', approvedBy, approvedAt: now },
      });
      if (claimed.count === 0) {
        throw new Error('Solicitação já foi processada');
      }

      // Aprovar uma solicitação antiga nunca reativa um dispositivo bloqueado/revogado (e nunca emite credencial
      // para ele): liberar exige o desbloqueio explícito.
      const activated = await tx.device.updateMany({
        where: { id: activation.deviceId, status: { notIn: ['BLOCKED', 'REVOKED'] } },
        data: { status: 'ACTIVE', activatedBy: approvedBy, activatedAt: now },
      });
      if (activated.count === 0) {
        throw new Error('Dispositivo bloqueado ou revogado — desbloqueie-o antes de aprovar a ativação');
      }

      const updatedActivation = await tx.activation.findUniqueOrThrow({ where: { id: activationId } });
      const updatedDevice = await tx.device.findUniqueOrThrow({ where: { id: activation.deviceId } });
      return { updatedActivation, updatedDevice };
    });

    const credential = generateDeviceCredential({
      deviceId: activation.deviceId,
      licenseId: activation.licenseId,
      companyId: activation.license.companyId,
    });

    return { ...result, credential };
  }

  /**
   * Super ADM TI rejeita a solicitação.
   */
  async rejectActivation(activationId: string, approvedBy: string, reason?: string) {
    const activation = await prisma.activation.findUnique({ where: { id: activationId } });
    if (!activation) {
      throw new Error('Solicitação de ativação não encontrada');
    }
    if (activation.status !== 'PENDING') {
      throw new Error('Solicitação já foi processada');
    }

    return await runInTransaction(async (tx) => {
      const updatedActivation = await tx.activation.update({
        where: { id: activationId },
        data: { status: 'REJECTED', approvedBy, approvedAt: new Date() },
      });
      // O dispositivo criado junto com a solicitação rejeitada não deve
      // ficar "pendente" para sempre — fica revogado (precisa de nova
      // solicitação caso o cliente tente de novo).
      await tx.device.update({
        where: { id: activation.deviceId },
        data: {
          status: 'REVOKED',
          revokedBy: approvedBy,
          revokedAt: new Date(),
          revocationReason: reason || 'Solicitação de ativação rejeitada',
        },
      });
      return updatedActivation;
    });
  }

  /**
   * Bloquear dispositivo (reversível — diferente de revogar)
   */
  async blockDevice(deviceId: string, blockedBy: string, reason?: string) {
    const device = await this.requireDevice(deviceId);
    if (device.status === 'REVOKED') {
      throw new Error('Dispositivo revogado não pode ser bloqueado — já está permanentemente inativo');
    }

    // Bloquear também ENCERRA as sessões de equipamento e as renovações dele (acesso para na hora, não só no próximo login).
    const { device: updated } = await deviceEnrollmentService.blockOrRevoke({
      deviceId,
      actorId: blockedBy,
      mode: 'BLOCK',
      reason: reason || 'Bloqueado pelo Super ADM TI',
    });
    return updated;
  }

  /**
   * Desbloquear dispositivo — só é possível se estiver BLOCKED (não REVOKED)
   */
  async unblockDevice(deviceId: string) {
    const device = await this.requireDevice(deviceId);
    if (device.status !== 'BLOCKED') {
      throw new Error('Apenas dispositivos bloqueados podem ser desbloqueados');
    }

    // ACHADO DE AUDITORIA: `blockDevice` aceita um dispositivo ainda PENDING (recusado de
    // forma reversível). Desbloquear o promovia direto a ACTIVE — sem aprovação e sem a
    // credencial emitida em approveActivation — deixando o dispositivo ativo com a
    // ativação PENDING. Desbloquear só devolve ao estado anterior: ACTIVE se já houve
    // aprovação, senão volta a PENDING (a fila de análise decide).
    const approved = await prisma.activation.findFirst({
      where: { deviceId, status: 'APPROVED' },
      select: { id: true },
    });

    // Equipamento autorizado pelo enrolamento (device.activatedAt) não tem Activation, mas já foi aprovado: volta a ACTIVE.
    return await prisma.device.update({
      where: { id: deviceId },
      data: { status: approved || device.activatedAt ? 'ACTIVE' : 'PENDING', revokedBy: null, revocationReason: null },
    });
  }

  /**
   * Revogar dispositivo — permanente. Para usar o sistema de novo, o
   * cliente precisa solicitar uma nova ativação (novo Device).
   */
  async revokeDevice(deviceId: string, revokedBy: string, reason: string) {
    await this.requireDevice(deviceId);

    // Revogar encerra as sessões e renovações do equipamento na mesma transação (ver deviceEnrollmentService.blockOrRevoke).
    const { device } = await deviceEnrollmentService.blockOrRevoke({ deviceId, actorId: revokedBy, mode: 'REVOKE', reason });
    return device;
  }

  /**
   * Chamado pelo app cliente periodicamente para provar que está online e
   * atualizar o IP conhecido — não confunde com autenticação (isso é feito
   * pela credencial de dispositivo + login do usuário).
   */
  async recordHeartbeat(deviceId: string, ipAddress?: string, companyId?: string) {
    const device = await this.requireDevice(deviceId);
    // Só o próprio tenant sinaliza o equipamento (senão qualquer usuário marcava online o PDV de outra empresa).
    if (companyId) {
      const owned = await prisma.device.findFirst({ where: { id: deviceId, license: { companyId } }, select: { id: true } });
      if (!owned) throw new Error('Dispositivo não encontrado');
    }
    if (device.status !== 'ACTIVE') {
      throw new Error('Dispositivo não está ativo');
    }

    return await prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date(), ...(ipAddress && { ipAddress }) },
    });
  }

  async listDevicesByLicense(licenseId: string) {
    return await prisma.device.findMany({
      where: { licenseId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Todos os dispositivos da plataforma (Super ADM TI) — usado pela tela de
   * Dispositivos do Super Admin, que antes era um placeholder sem nenhuma
   * chamada à API apesar deste fluxo de ativação já existir por completo.
   *
   * ACHADO DE AUDITORIA: esta busca era um `findMany` sem `where`, `take` nem
   * `skip` — retornava TODOS os dispositivos já ativados por TODAS as
   * empresas da plataforma, para sempre (Device não tem soft-delete: bloquear
   * ou revogar só muda `status`, a linha nunca é removida). Diferente de uma
   * lista por empresa (limitada organicamente ao tamanho de UM tenant), esta
   * agrega a plataforma inteira numa única tela — cresce sem teto conforme
   * mais empresas fazem onboarding. Mesmo padrão do bug já corrigido em
   * `GET /users` (user.service.ts findAll), agora em escopo de plataforma.
   */
  async listAllDevices(pagination: { page?: number; limit?: number } = {}) {
    const page = pagination.page && pagination.page > 0 ? pagination.page : 1;
    const limit = pagination.limit && pagination.limit > 0 ? Math.min(pagination.limit, 100) : 20;

    const [devices, total] = await Promise.all([
      prisma.device.findMany({
        include: {
          license: { include: { company: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.device.count(),
    ]);

    return {
      devices,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
  }

  private async requireDevice(deviceId: string) {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      throw new Error('Dispositivo não encontrado');
    }
    return device;
  }
}

export default new ActivationService();
