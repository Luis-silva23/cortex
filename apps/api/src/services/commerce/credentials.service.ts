import crypto from 'crypto';
import { prisma, prismaUnsafeBypassRLS, runInTransaction, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { sealSecret } from '@ln-system/shared/utils/secret-box';
import type { ChannelCredentialScope } from '@prisma/client';

/**
 * Credenciais que um CANAL usa para chamar a Commerce API (não confundir com `SalesChannel.credentialsEncrypted`, que é o que o
 * CÓRTEX usa num provedor). O segredo é gerado aqui, mostrado UMA vez na criação e guardado cifrado (`enc:v1`, o HMAC precisa dele);
 * nenhuma leitura o devolve. Empresa e filial da credencial são as do canal — nunca vêm da requisição.
 */
export const ALL_SCOPES: ChannelCredentialScope[] = ['CATALOG_READ', 'ORDERS_READ', 'ORDERS_WRITE', 'PAYMENT_EVENTS_WRITE'];
/** Tipos de canal que usam a Commerce API (o site próprio e a origem manual). iFood e marketplaces usam o gateway, não esta API. */
export const COMMERCE_CHANNEL_TYPES = ['SITE_PROPRIO', 'OUTRO'];
export const KEY_ID_PATTERN = /^ck_[0-9a-f]{20}$/;
const MAX_ACTIVE_PER_CHANNEL = 5;
const DEFAULT_ROTATION_OVERLAP_HOURS = 24;

export interface CredentialView {
  id: string;
  channelId: string;
  keyId: string;
  label: string;
  scopes: ChannelCredentialScope[];
  secretHint: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

function view(row: any): CredentialView {
  return {
    id: row.id,
    channelId: row.channelId,
    keyId: row.keyId,
    label: row.label,
    scopes: row.scopes,
    secretHint: row.secretHint,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

export function generateKeyMaterial(): { keyId: string; secret: string } {
  return { keyId: `ck_${crypto.randomBytes(10).toString('hex')}`, secret: `cs_${crypto.randomBytes(32).toString('base64url')}` };
}

export const isUsable = (cred: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()) =>
  !cred.revokedAt && (!cred.expiresAt || cred.expiresAt.getTime() > now.getTime());

async function channelFor(companyId: string, channelId: string) {
  const channel = await prisma.salesChannel.findFirst({ where: { id: channelId, companyId } });
  if (!channel) throw new AppError('Canal não encontrado', 404, 'CHANNEL_NOT_FOUND');
  return channel;
}

const commerceCredentialService = {
  async create(input: { companyId: string; channelId: string; label: string; scopes: ChannelCredentialScope[]; expiresAt?: Date | null; actorId: string; correlationId?: string }) {
    const channel = await channelFor(input.companyId, input.channelId);
    if (!COMMERCE_CHANNEL_TYPES.includes(channel.type)) throw new AppError('Este tipo de canal não usa a Commerce API', 409, 'CHANNEL_TYPE_NOT_SUPPORTED');
    if (!channel.branchId) throw new AppError('Vincule o canal a uma filial de atendimento antes de emitir credenciais', 409, 'CHANNEL_BRANCH_REQUIRED');
    const scopes = [...new Set(input.scopes)];
    if (scopes.length === 0 || scopes.some((s) => !ALL_SCOPES.includes(s))) throw new AppError('Escopos inválidos', 400, 'VALIDATION_ERROR');
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new AppError('A validade precisa ser futura', 400, 'VALIDATION_ERROR');

    const { keyId, secret } = generateKeyMaterial();
    const row = await runInTransaction(async (tx) => {
      const active = await tx.channelApiCredential.count({
        where: { channelId: channel.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      });
      if (active >= MAX_ACTIVE_PER_CHANNEL) throw new AppError(`Limite de ${MAX_ACTIVE_PER_CHANNEL} credenciais ativas por canal`, 409, 'CREDENTIAL_LIMIT');
      const created = await tx.channelApiCredential.create({
        data: {
          companyId: channel.companyId,
          branchId: channel.branchId,
          channelId: channel.id,
          keyId,
          secretEncrypted: sealSecret(secret),
          secretHint: `••••${secret.slice(-4)}`,
          label: input.label,
          scopes,
          expiresAt: input.expiresAt ?? null,
          createdBy: input.actorId,
        },
      });
      // Credencial emitida, ainda não usada: o canal passa de "configuração pendente" para "não validada". Conectado só na 1ª chamada real.
      await tx.salesChannel.updateMany({ where: { id: channel.id, connectionStatus: 'NOT_CONFIGURED' }, data: { connectionStatus: 'UNVALIDATED' } });
      await tx.channelEvent.create({
        data: {
          companyId: channel.companyId,
          branchId: channel.branchId,
          channelId: channel.id,
          type: 'API_CREDENTIAL_CREATED',
          level: 'INFO',
          message: `Credencial da Commerce API criada (${keyId})`,
          actorId: input.actorId,
          correlationId: input.correlationId ?? null,
          data: { keyId, scopes, expiresAt: input.expiresAt ?? null } as any,
        },
      });
      return created;
    });
    // O segredo só existe aqui, no retorno da criação.
    return { credential: view(row), secret };
  },

  async list(companyId: string, channelId: string): Promise<CredentialView[]> {
    const channel = await channelFor(companyId, channelId);
    const rows = await prisma.channelApiCredential.findMany({ where: { channelId: channel.id }, orderBy: { createdAt: 'desc' } });
    return rows.map(view);
  },

  /** Revoga na hora. Repetir é inofensivo (idempotente). */
  async revoke(input: { companyId: string; channelId: string; credentialId: string; actorId: string; correlationId?: string }): Promise<CredentialView> {
    const channel = await channelFor(input.companyId, input.channelId);
    const existing = await prisma.channelApiCredential.findFirst({ where: { id: input.credentialId, channelId: channel.id } });
    if (!existing) throw new AppError('Credencial não encontrada', 404, 'CREDENTIAL_NOT_FOUND');
    if (existing.revokedAt) return view(existing);
    return runInTransaction(async (tx) => {
      const res = await tx.channelApiCredential.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: input.actorId } });
      if (res.count === 1) {
        await tx.channelEvent.create({
          data: {
            companyId: channel.companyId,
            branchId: channel.branchId,
            channelId: channel.id,
            type: 'API_CREDENTIAL_REVOKED',
            level: 'WARN',
            message: `Credencial da Commerce API revogada (${existing.keyId})`,
            actorId: input.actorId,
            correlationId: input.correlationId ?? null,
            data: { keyId: existing.keyId } as any,
          },
        });
      }
      return view(await tx.channelApiCredential.findUniqueOrThrow({ where: { id: existing.id } }));
    });
  },

  /** Emite uma credencial nova com os mesmos escopos e deixa a antiga valer só por mais `overlapHours` (troca sem derrubar o canal). */
  async rotate(input: { companyId: string; channelId: string; credentialId: string; actorId: string; overlapHours?: number; correlationId?: string }) {
    const channel = await channelFor(input.companyId, input.channelId);
    const old = await prisma.channelApiCredential.findFirst({ where: { id: input.credentialId, channelId: channel.id } });
    if (!old || !isUsable(old)) throw new AppError('Credencial não encontrada ou já inativa', 404, 'CREDENTIAL_NOT_FOUND');
    const overlapMs = Math.min(Math.max(input.overlapHours ?? DEFAULT_ROTATION_OVERLAP_HOURS, 0), 24 * 7) * 3600_000;
    const created = await this.create({ companyId: input.companyId, channelId: channel.id, label: old.label, scopes: old.scopes, expiresAt: old.expiresAt, actorId: input.actorId, correlationId: input.correlationId });
    const until = new Date(Date.now() + overlapMs);
    await prisma.channelApiCredential.updateMany({
      where: { id: old.id, revokedAt: null },
      data: { expiresAt: old.expiresAt && old.expiresAt < until ? old.expiresAt : until },
    });
    return created;
  },
};

export default commerceCredentialService;

// ---------------------------------------------------------------------------------------------------------------------
// Busca para autenticação: roda ANTES de existir contexto de empresa (a chave identifica a empresa). Por isso é a ÚNICA consulta
// da Commerce API que usa o cliente sem RLS, restrita a uma credencial por `keyId` exato. Tudo depois disso roda com o contexto do canal.
// ---------------------------------------------------------------------------------------------------------------------
export async function findCredentialForAuth(keyId: string) {
  const [, row] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    prismaUnsafeBypassRLS.channelApiCredential.findUnique({ where: { keyId }, include: { channel: true } }),
  ]);
  return row;
}

/**
 * Primeira chamada assinada válida de um canal = validação REAL da conexão (o site provou que tem a chave e alcança o CÓRTEX):
 * só então o canal passa a CONNECTED. Idempotente (só muda se ainda não estava conectado) e nunca afeta a requisição.
 */
export function markChannelConnected(channel: { id: string; companyId: string; branchId: string | null }, keyId: string): void {
  prismaUnsafeBypassRLS
    .$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.salesChannel.updateMany({
        where: { id: channel.id, connectionStatus: { not: 'CONNECTED' } },
        data: { connectionStatus: 'CONNECTED', lastError: null, lastSyncAt: new Date() },
      }),
    ])
    .then(async (res) => {
      const count = (res as unknown as [unknown, { count: number }])[1]?.count ?? 0;
      if (count !== 1) return;
      await prismaUnsafeBypassRLS.$transaction([
        contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
        prismaUnsafeBypassRLS.channelEvent.create({
          data: {
            companyId: channel.companyId,
            branchId: channel.branchId,
            channelId: channel.id,
            type: 'CONNECTION_VALIDATED',
            level: 'INFO',
            message: 'Primeira chamada assinada válida recebida pela Commerce API: conexão validada',
            data: { keyId } as any,
          },
        }),
      ]);
    })
    .catch(() => undefined);
}

const lastTouched = new Map<string, number>();
/** Atualiza `lastUsedAt` no máximo uma vez por minuto por credencial; falha aqui nunca afeta a requisição. */
export function touchLastUsed(credentialId: string): void {
  const now = Date.now();
  if ((lastTouched.get(credentialId) ?? 0) > now - 60_000) return;
  lastTouched.set(credentialId, now);
  prismaUnsafeBypassRLS
    .$transaction([
      contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
      prismaUnsafeBypassRLS.channelApiCredential.updateMany({ where: { id: credentialId }, data: { lastUsedAt: new Date(now) } }),
    ])
    .catch(() => undefined);
}
