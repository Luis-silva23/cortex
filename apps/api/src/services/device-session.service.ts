import { prisma, Prisma, runWithRLSContext } from '@ln-system/database';
import { Logger } from './logger.service';

/**
 * Sessão única por PDV/equipamento e por usuário (ver FASE 8 do plano de
 * execução). A garantia é do BANCO, não de uma checagem "SELECT antes,
 * INSERT depois" na aplicação: `device_sessions` tem dois índices únicos
 * PARCIAIS (`WHERE status = 'ACTIVE'`) — um por deviceId, um por userId
 * (ver migration 20260907225607_device_sessions_constraints_and_rls). Duas
 * tentativas de abrir sessão simultâneas no MESMO PDV, ou do MESMO
 * usuário em dois PDVs ao mesmo tempo, competem pelo mesmo índice — o
 * Postgres deixa só uma passar, a outra recebe violação de unicidade
 * (P2002), tratada abaixo como "PDV ocupado"/"usuário já tem sessão ativa".
 */

export class DeviceSessionError extends Error {
  constructor(
    message: string,
    public code: 'DEVICE_BUSY' | 'USER_ALREADY_ACTIVE'
  ) {
    super(message);
  }
}

/**
 * Equipamento não autorizado a abrir sessão (o login é recusado com 403 e o código). Os códigos NÃO distinguem "não existe" de "é de
 * outra empresa" (`DEVICE_UNKNOWN`): quem chega aqui já provou a senha, mas não deve descobrir equipamentos alheios.
 */
export class DeviceAuthError extends Error {
  constructor(
    message: string,
    public code: 'DEVICE_UNKNOWN' | 'DEVICE_PENDING' | 'DEVICE_BLOCKED' | 'DEVICE_REVOKED' | 'DEVICE_KEY_INVALID' | 'DEVICE_BRANCH_MISMATCH' | 'DEVICE_REQUIRED' | 'DEVICE_REENROLL_REQUIRED'
  ) {
    super(message);
  }
}

/**
 * Encerra (FORCE_ENDED) as sessões de equipamento ativas e revoga as renovações presas a elas, dentro da transação de quem bloqueia ou
 * revoga o equipamento. O access token só vale enquanto a sessão estiver ativa (conferido a cada requisição), então o acesso para NA HORA.
 */
export async function endActiveSessionsOfDevice(
  tx: Pick<Prisma.TransactionClient, 'deviceSession' | 'refreshToken'>,
  deviceId: string,
  by: { endedBy: string; reason: string }
): Promise<number> {
  const sessions = await tx.deviceSession.findMany({ where: { deviceId, status: 'ACTIVE' }, select: { id: true } });
  if (sessions.length === 0) return 0;
  const ids = sessions.map((s) => s.id);
  await tx.deviceSession.updateMany({ where: { id: { in: ids } }, data: { status: 'FORCE_ENDED', endedAt: new Date(), endedBy: by.endedBy, endReason: by.reason } });
  await tx.refreshToken.updateMany({ where: { deviceSessionId: { in: ids }, isRevoked: false }, data: { isRevoked: true } });
  clearDeviceSessionCache();
  return ids.length;
}

// Cache MUITO curto (segundos) só do "sim, está ativa": a conferência roda a cada requisição de um equipamento e a revogação precisa
// valer logo. O "não" nunca é guardado. Vale por instância; a fonte da verdade é sempre o PostgreSQL.
const LIVE_CACHE_MS = 3000;
const liveCache = new Map<string, number>();

/** A sessão de equipamento do token ainda está ativa e o equipamento continua ativo? (fonte: PostgreSQL) */
export async function isDeviceSessionLive(sessionId: string, now = Date.now()): Promise<boolean> {
  const cachedUntil = liveCache.get(sessionId);
  if (cachedUntil && cachedUntil > now) return true;
  const row = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
    prisma.deviceSession.findFirst({ where: { id: sessionId, status: 'ACTIVE', device: { status: 'ACTIVE' } }, select: { id: true } })
  );
  if (!row) {
    liveCache.delete(sessionId);
    return false;
  }
  if (liveCache.size > 5000) liveCache.clear();
  liveCache.set(sessionId, now + LIVE_CACHE_MS);
  return true;
}

/** Descarta o cache (revogação, encerramento e logout valem na hora nesta instância). Também usado nos testes. */
export function clearDeviceSessionCache() {
  liveCache.clear();
}

/**
 * O PDV não restaura sessão: se o processo morreu (queda de energia, gerenciador de tarefas), o token da sessão de equipamento só
 * existia na memória dele e ninguém chamou /logout — a sessão ficou ATIVA e, pela regra "um equipamento = uma sessão", trancaria
 * o PRÓPRIO operador do lado de fora (DEVICE_BUSY). Quem acabou de provar a senha E a chave do equipamento (é o chamador) e é o
 * MESMO dono da sessão presa a encerra e a substitui; as renovações dela são revogadas. Sessão de OUTRO operador nunca é tocada
 * aqui: continua DEVICE_BUSY até o encerramento administrativo (forceEndDeviceSession).
 */
async function supersedeOwnStuckSession(deviceId: string, userId: string) {
  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    const stuck = await prisma.deviceSession.findMany({ where: { deviceId, userId, status: 'ACTIVE' }, select: { id: true } });
    if (stuck.length === 0) return;
    const ids = stuck.map((s) => s.id);
    await prisma.deviceSession.updateMany({
      where: { id: { in: ids }, status: 'ACTIVE' },
      data: { status: 'ENDED', endedAt: new Date(), endedBy: userId, endReason: 'SUPERSEDED_BY_RELOGIN' },
    });
    await prisma.refreshToken.updateMany({ where: { deviceSessionId: { in: ids }, isRevoked: false }, data: { isRevoked: true } });
  });
  clearDeviceSessionCache();
}

/** Encerra UMA sessão de equipamento (a do refresh token que saiu). Não toca nas outras sessões do mesmo usuário. */
export async function endDeviceSessionById(sessionId: string, endedBy: string) {
  await prisma.deviceSession.updateMany({
    where: { id: sessionId, status: 'ACTIVE' },
    data: { status: 'ENDED', endedAt: new Date(), endedBy },
  });
  clearDeviceSessionCache();
}

export async function startDeviceSession(data: {
  deviceId: string;
  userId: string;
  companyId: string;
  branchId?: string | null;
  ipAddress?: string;
}) {
  await supersedeOwnStuckSession(data.deviceId, data.userId);
  try {
    return await prisma.deviceSession.create({
      data: {
        deviceId: data.deviceId,
        userId: data.userId,
        companyId: data.companyId,
        branchId: data.branchId ?? undefined,
        ipAddress: data.ipAddress,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Os dois índices únicos parciais que garantem a regra foram criados
      // via SQL bruto na migration (não como `@@unique` no schema.prisma),
      // então o Prisma NÃO consegue preencher `error.meta.target` com o
      // nome da constraint (confirmado: vem `null`) — checar o texto de
      // `target` (como se fazia antes) sempre caía no branch errado,
      // classificando toda colisão como "usuário já ativo" mesmo quando o
      // conflito real era o equipamento ocupado por outro usuário. Em vez
      // de depender de `target`, perguntamos ao banco qual das duas
      // situações é verdadeira — o INSERT acima já falhou de verdade
      // (a garantia de concorrência já foi aplicada); esta consulta só
      // decide QUAL mensagem/código mostrar.
      const deviceConflict = await prisma.deviceSession.findFirst({
        where: { deviceId: data.deviceId, status: 'ACTIVE' },
        include: { user: { select: { name: true } } },
      });
      if (deviceConflict) {
        throw new DeviceSessionError(
          `Este PDV já está em uso por ${deviceConflict.user?.name ?? 'outro operador'}. Peça a um gerente/administrador para encerrar a sessão travada, se necessário.`,
          'DEVICE_BUSY'
        );
      }
      throw new DeviceSessionError(
        'Este usuário já tem uma sessão ativa em outro PDV. Encerre a sessão anterior antes de entrar em um novo equipamento.',
        'USER_ALREADY_ACTIVE'
      );
    }
    throw error;
  }
}

export async function endDeviceSessionByUser(userId: string) {
  await prisma.deviceSession.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'ENDED', endedAt: new Date(), endedBy: userId },
  });
  clearDeviceSessionCache();
}

/**
 * Encerramento ADMINISTRATIVO de uma sessão travada — usado quando um PDV
 * trava (queda de energia, crash do app) sem passar pelo logout normal e
 * um gerente/admin precisa liberar o equipamento. Sempre exige quem
 * encerrou e o motivo, e gera log de segurança (auditoria).
 */
export async function forceEndDeviceSession(data: {
  deviceId: string;
  endedByUserId: string;
  endedByName: string;
  reason: string;
  companyId: string;
}) {
  const session = await prisma.deviceSession.findFirst({
    where: { deviceId: data.deviceId, status: 'ACTIVE', companyId: data.companyId },
  });

  if (!session) {
    throw new Error('Nenhuma sessão ativa encontrada para este PDV');
  }

  const updated = await prisma.deviceSession.update({
    where: { id: session.id },
    data: {
      status: 'FORCE_ENDED',
      endedAt: new Date(),
      endedBy: data.endedByUserId,
      endReason: data.reason,
    },
  });
  // A renovação presa a esta sessão também morre: sem isto o equipamento "encerrado" renovava o token e voltava.
  await prisma.refreshToken.updateMany({ where: { deviceSessionId: session.id, isRevoked: false }, data: { isRevoked: true } });
  clearDeviceSessionCache();

  Logger.security(
    'DEVICE_SESSION_FORCE_ENDED',
    `Sessão do PDV encerrada administrativamente por ${data.endedByName}: ${data.reason}`,
    {
      companyId: data.companyId,
      userId: data.endedByUserId,
      device: data.deviceId,
    }
  );

  return updated;
}
