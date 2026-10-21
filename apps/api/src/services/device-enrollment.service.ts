import * as crypto from 'crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, runInTransaction, runWithRLSContext } from '@ln-system/database';
import { AppError, ConflictError } from '@ln-system/shared';
import { endActiveSessionsOfDevice } from './device-session.service';

/**
 * ENROLAMENTO E AUTORIZAÇÃO DE EQUIPAMENTO (docs/CORTEX/DISPOSITIVOS.md). Rede alcançada ≠ equipamento autorizado ≠ acesso:
 *
 *   instalação → `enroll` (público, sem dado nenhum): cria o equipamento PENDENTE, SEM empresa e SEM filial, e devolve uma CHAVE
 *   (mostrada uma vez; no banco só o hash) e um código curto → o aplicativo mostra "aguardando autorização" e consulta `status`
 *   → o administrador (Super ADM TI) confere o código, escolhe a LICENÇA (empresa) e a FILIAL e autoriza → o equipamento vira ATIVO
 *   → só então o login (que exige equipamento ativo + chave) abre a sessão de equipamento.
 *
 * O equipamento NUNCA escolhe empresa nem filial; IP, MAC e nome são só informação para o administrador (não são identidade).
 * A identidade é o id persistente + a chave secreta; revogar/bloquear encerra as sessões e as renovações.
 */
const SYSTEM = { companyId: null, userType: 'SUPER_ADMIN', branchId: null } as const;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem I, L, O, 0, 1 (confundem na tela)
export const PENDING_MAX_AGE_DAYS = 7;
export const PENDING_QUEUE_CAP = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const hashDeviceKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');
export const newDeviceKey = () => `dk_${crypto.randomBytes(32).toString('base64url')}`;

export function newEnrollmentCode(): string {
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Compara a chave apresentada com o hash guardado, em tempo constante. Sem hash guardado (legado) ou sem chave: nunca confere. */
export function deviceKeyMatches(secretHash: string | null | undefined, provided: string | null | undefined): boolean {
  if (!secretHash || !provided || typeof provided !== 'string' || provided.length > 200) return false;
  const a = Buffer.from(hashDeviceKey(provided), 'hex');
  const b = Buffer.from(secretHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const enrollSchema = z
  .object({
    deviceName: z.string().trim().min(2, 'Informe o nome do equipamento').max(80),
    deviceType: z.enum(['DESKTOP', 'TABLET', 'MOBILE', 'POS']),
    /** MAC, hostname ou modelo: só ajuda o administrador a reconhecer a máquina. NÃO é identidade. */
    hardwareHint: z.string().trim().max(64).optional(),
  })
  .strict();

const invalidCredential = () => new AppError('Credencial do equipamento inválida', 401, 'DEVICE_CREDENTIAL_INVALID');

export const deviceEnrollmentService = {
  /** Cria o equipamento PENDENTE. Público: não lê nada do banco além da fila de pendentes e não devolve dado de empresa. */
  async enroll(raw: unknown, ip?: string) {
    const parsed = enrollSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(parsed.error.issues.map((i) => i.message).join('; '), 400, 'VALIDATION_ERROR');
    const input = parsed.data;
    const deviceKey = newDeviceKey();

    return runWithRLSContext(SYSTEM, async () => {
      // Pendência esquecida não ocupa a fila para sempre.
      await prisma.device.deleteMany({ where: { licenseId: null, status: 'PENDING', createdAt: { lt: new Date(Date.now() - PENDING_MAX_AGE_DAYS * 86_400_000) } } });
      const waiting = await prisma.device.count({ where: { licenseId: null, status: 'PENDING' } });
      if (waiting >= PENDING_QUEUE_CAP) throw new AppError('Fila de autorização cheia. Tente novamente mais tarde.', 503, 'ENROLLMENT_QUEUE_FULL');

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const device = await prisma.device.create({
            data: {
              deviceName: input.deviceName,
              deviceType: input.deviceType,
              status: 'PENDING',
              macAddress: input.hardwareHint ?? null,
              ipAddress: ip ?? null,
              secretHash: hashDeviceKey(deviceKey),
              enrollmentCode: newEnrollmentCode(),
            },
          });
          return { deviceId: device.id, deviceKey, enrollmentCode: device.enrollmentCode as string, status: 'PENDING' as const };
        } catch (err) {
          if ((err as { code?: string })?.code === 'P2002') continue; // código curto repetido: gera outro
          throw err;
        }
      }
      throw new AppError('Não foi possível registrar o equipamento. Tente novamente.', 503, 'ENROLLMENT_UNAVAILABLE');
    });
  },

  /**
   * Estado do equipamento (o "bootstrap" do aplicativo). Exige o id E a chave: sem a chave certa responde sempre o mesmo 401, sem dizer
   * se o equipamento existe. Antes de autorizado não devolve nada de empresa, filial, produto, cliente ou usuário.
   */
  async status(input: { deviceId?: unknown; deviceKey?: unknown }) {
    const deviceId = typeof input.deviceId === 'string' && UUID.test(input.deviceId) ? input.deviceId : null;
    const deviceKey = typeof input.deviceKey === 'string' ? input.deviceKey : null;
    if (!deviceId || !deviceKey) throw invalidCredential();

    return runWithRLSContext(SYSTEM, async () => {
      const device = await prisma.device.findUnique({ where: { id: deviceId }, include: { license: { select: { companyId: true, company: { select: { name: true } } } } } });
      if (!device || !deviceKeyMatches(device.secretHash, deviceKey)) throw invalidCredential();

      // "visto por último" ao consultar (no máximo uma escrita por minuto por equipamento)
      await prisma.device.updateMany({ where: { id: device.id, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(Date.now() - 60_000) } }] }, data: { lastSeenAt: new Date() } });

      const base = { deviceId: device.id, status: device.status, deviceName: device.deviceName };
      if (device.status === 'PENDING') return { ...base, enrollmentCode: device.enrollmentCode };
      if (device.status !== 'ACTIVE') return base; // BLOQUEADO/REVOGADO: nada mais
      const branch = device.branchId ? await prisma.branch.findFirst({ where: { id: device.branchId, companyId: device.license?.companyId }, select: { name: true } }) : null;
      return { ...base, company: device.license?.company ? { name: device.license.company.name } : null, branch: branch ? { name: branch.name } : null };
    });
  },

  /** Fila de análise (Super ADM TI): equipamentos que pediram acesso e ainda não têm empresa. */
  async listPending() {
    return prisma.device.findMany({
      where: { licenseId: null, status: 'PENDING' },
      select: { id: true, deviceName: true, deviceType: true, macAddress: true, ipAddress: true, enrollmentCode: true, createdAt: true, lastSeenAt: true },
      orderBy: { createdAt: 'asc' },
      take: PENDING_QUEUE_CAP,
    });
  },

  /**
   * O administrador VINCULA o equipamento a uma licença (empresa) e a uma filial e o ativa. A filial precisa ser da empresa da licença;
   * a licença precisa estar ativa e ter vaga (a conferência e a ativação são serializadas pela licença: duas autorizações simultâneas
   * não passam do limite contratado). Autorizar é idempotente só no sentido de que o segundo pedido é recusado (409).
   */
  async authorize(input: { deviceId: string; licenseId: string; branchId: string; deviceName?: string; actorId: string }) {
    return runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM licenses WHERE id = ${input.licenseId} FOR UPDATE`;
      const license = await tx.license.findUnique({ where: { id: input.licenseId } });
      if (!license) throw new AppError('Licença não encontrada', 404, 'LICENSE_NOT_FOUND');
      if (license.status !== 'ACTIVE') throw new ConflictError('Licença não está ativa', 'LICENSE_NOT_ACTIVE');
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, companyId: license.companyId, isActive: true }, select: { id: true } });
      if (!branch) throw new AppError('Filial não pertence à empresa da licença', 404, 'BRANCH_NOT_FOUND');

      const used = await tx.device.count({ where: { licenseId: license.id, status: { in: ['PENDING', 'ACTIVE', 'BLOCKED'] } } });
      if (used >= license.maxDevices) throw new ConflictError(`Limite de dispositivos atingido (${license.maxDevices}). Revogue um equipamento antes de autorizar outro.`, 'DEVICE_LIMIT_REACHED');

      const claimed = await tx.device.updateMany({
        where: { id: input.deviceId, status: 'PENDING', licenseId: null },
        data: { licenseId: license.id, branchId: branch.id, status: 'ACTIVE', activatedBy: input.actorId, activatedAt: new Date(), ...(input.deviceName ? { deviceName: input.deviceName.slice(0, 80) } : {}) },
      });
      if (claimed.count !== 1) throw new ConflictError('Equipamento não está aguardando autorização (já foi tratado ou não existe)', 'DEVICE_NOT_PENDING');
      return tx.device.findUniqueOrThrow({ where: { id: input.deviceId }, select: { id: true, deviceName: true, deviceType: true, status: true, licenseId: true, branchId: true, activatedAt: true } });
    });
  },

  /**
   * Bloqueia (reversível) ou revoga (permanente) E encerra, na mesma transação, as sessões de equipamento e as renovações presas a elas:
   * o acesso para na hora (o token é conferido contra a sessão a cada requisição), não só "no próximo login".
   */
  async blockOrRevoke(input: { deviceId: string; actorId: string; mode: 'BLOCK' | 'REVOKE'; reason: string }) {
    return runInTransaction(async (tx) => {
      const device = await tx.device.findUnique({ where: { id: input.deviceId } });
      if (!device) throw new AppError('Equipamento não encontrado', 404, 'DEVICE_NOT_FOUND');
      if (device.status === 'REVOKED') throw new ConflictError('Equipamento já está revogado', 'DEVICE_REVOKED');
      if (input.mode === 'BLOCK' && device.status === 'BLOCKED') throw new ConflictError('Equipamento já está bloqueado', 'DEVICE_BLOCKED');
      const updated = await tx.device.update({
        where: { id: input.deviceId },
        data:
          input.mode === 'REVOKE'
            ? { status: 'REVOKED', revokedBy: input.actorId, revokedAt: new Date(), revocationReason: input.reason }
            : { status: 'BLOCKED', revokedBy: input.actorId, revocationReason: input.reason },
      });
      const ended = await endActiveSessionsOfDevice(tx as Prisma.TransactionClient, input.deviceId, { endedBy: input.actorId, reason: input.mode === 'REVOKE' ? 'Equipamento revogado' : 'Equipamento bloqueado' });
      return { device: updated, endedSessions: ended };
    });
  },
};

export default deviceEnrollmentService;
