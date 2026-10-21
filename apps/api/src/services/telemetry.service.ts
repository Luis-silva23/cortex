import { prisma } from '@ln-system/database';
import { Prisma } from '@prisma/client';

export type TelemetryInput = {
  collectedAt: string;
  cpuLoadPct?: number | null;
  memUsedPct?: number | null;
  diskUsedPct?: number | null;
  apiRttMs?: number | null;
  packetLossPct?: number | null;
  appVersion?: string | null;
  runtimeVersion?: string | null;
  uptimeSec?: number | null;
};

export class TelemetryError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const MAX_PAST_MS = 10 * 60_000;
const MAX_FUTURE_MS = 2 * 60_000;
const MIN_INTERVAL_MS = 30_000;
const pct = (v?: number | null) => (v === null || v === undefined ? null : Math.min(100, Math.max(0, v)));

/**
 * Ingestão da telemetria do equipamento. Equipamento, empresa e filial vêm da sessão de equipamento ATIVA do usuário
 * autenticado (nunca do corpo): um equipamento não se passa por outro nem por outra filial. Horário de coleta fora da
 * janela é recusado (replay/relógio adulterado), coleta repetida é ignorada, e mais de uma a cada 30 s é recusada.
 */
export class TelemetryService {
  async ingest(user: { userId: string; companyId?: string | null }, input: TelemetryInput) {
    if (!user.companyId) throw new TelemetryError('Telemetria é enviada por usuário de empresa', 400);
    const session = await prisma.deviceSession.findFirst({
      where: { userId: user.userId, companyId: user.companyId, status: 'ACTIVE' },
      select: { deviceId: true, branchId: true },
    });
    if (!session) throw new TelemetryError('Nenhum equipamento ativo para este usuário', 409);

    const collectedAt = new Date(input.collectedAt);
    const drift = collectedAt.getTime() - Date.now();
    if (Number.isNaN(collectedAt.getTime()) || drift < -MAX_PAST_MS || drift > MAX_FUTURE_MS) {
      throw new TelemetryError('Horário de coleta fora da janela aceita', 400);
    }

    const last = await prisma.deviceTelemetry.findFirst({
      where: { deviceId: session.deviceId },
      orderBy: { collectedAt: 'desc' },
      select: { collectedAt: true },
    });
    if (last && last.collectedAt.getTime() !== collectedAt.getTime() && Math.abs(collectedAt.getTime() - last.collectedAt.getTime()) < MIN_INTERVAL_MS) {
      throw new TelemetryError('Telemetria enviada com frequência acima do permitido', 429);
    }

    try {
      await prisma.deviceTelemetry.create({
        data: {
          companyId: user.companyId,
          branchId: session.branchId,
          deviceId: session.deviceId,
          userId: user.userId,
          collectedAt,
          cpuLoadPct: pct(input.cpuLoadPct),
          memUsedPct: pct(input.memUsedPct),
          diskUsedPct: pct(input.diskUsedPct),
          packetLossPct: pct(input.packetLossPct),
          apiRttMs: input.apiRttMs === null || input.apiRttMs === undefined ? null : Math.min(60_000, Math.max(0, Math.round(input.apiRttMs))),
          uptimeSec: input.uptimeSec === null || input.uptimeSec === undefined ? null : Math.max(0, Math.round(input.uptimeSec)),
          appVersion: input.appVersion?.slice(0, 40) ?? null,
          runtimeVersion: input.runtimeVersion?.slice(0, 80) ?? null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { accepted: false, duplicate: true, deviceId: session.deviceId };
      }
      throw error;
    }
    await prisma.device.update({ where: { id: session.deviceId }, data: { lastSeenAt: new Date() } });
    return { accepted: true, duplicate: false, deviceId: session.deviceId };
  }
}

export default new TelemetryService();
