import { prisma, runInTransaction } from '@ln-system/database';
import type { ChannelConnectionStatus, SalesChannel, SalesChannelType } from '@prisma/client';
import { AppError } from '@ln-system/shared';
import { openSecret, sealSecret } from '@ln-system/shared/utils/secret-box';
import { callProviderSafely, providerRegistry, sanitizeErrorMessage, type ChannelContext } from './gateway';

/**
 * Canais de venda por empresa/filial (docs/CORTEX/CANAIS.md). Esta camada só CONFIGURA: tipo, nome exibido, ativo/inativo,
 * credencial protegida, teste de conexão e registro de eventos. Não chama nenhum serviço externo por conta própria e nunca
 * marca um canal como "Conectado" sem um teste real de um provedor instalado (hoje não há nenhum).
 *
 * O tipo técnico (`SITE_PROPRIO`, `IFOOD`...) não muda depois de criado: histórico e integrações dependem dele. O nome exibido é
 * livre e é o que o painel mostra. Venda sem canal é loja física.
 */

export const CHANNEL_TYPE_LABELS: Record<SalesChannelType, string> = {
  LOJA_FISICA: 'Loja física',
  SITE_PROPRIO: 'Site próprio',
  IFOOD: 'iFood',
  MARKETPLACE: 'Marketplace',
  OUTRO: 'Outro canal',
};

/** Chave do provedor de integração que o tipo espera. Nula = origem sem integração (marcação manual da origem da venda). */
const DEFAULT_PROVIDER: Record<SalesChannelType, string | null> = {
  LOJA_FISICA: null,
  // O site próprio usa a Commerce API como canal de ENTRADA: é o site que chama o CÓRTEX, e o CÓRTEX não chama ninguém, então não há
  // provedor a testar. A conexão vira CONNECTED sozinha na primeira chamada assinada válida (validação real; ver `markChannelConnected`).
  SITE_PROPRIO: null,
  IFOOD: 'ifood',
  MARKETPLACE: null,
  OUTRO: null,
};

export const NO_PROVIDER_MESSAGE = 'Nenhum provedor de integração está instalado para este canal. Nada foi chamado e o canal não foi marcado como conectado.';

export interface ChannelView {
  id: string;
  companyId: string;
  branchId: string | null;
  type: SalesChannelType;
  typeLabel: string;
  displayName: string;
  isActive: boolean;
  provider: string | null;
  connectionStatus: ChannelConnectionStatus;
  lastSyncAt: Date | null;
  lastError: string | null;
  externalAccountId: string | null;
  config: unknown;
  hasCredentials: boolean;
  credentialsHint: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Visão devolvida pela API: NUNCA inclui a credencial (nem cifrada). */
export function toView(c: SalesChannel): ChannelView {
  return {
    id: c.id,
    companyId: c.companyId,
    branchId: c.branchId,
    type: c.type,
    typeLabel: CHANNEL_TYPE_LABELS[c.type],
    displayName: c.displayName,
    isActive: c.isActive,
    provider: c.provider,
    connectionStatus: c.connectionStatus,
    lastSyncAt: c.lastSyncAt,
    lastError: c.lastError,
    externalAccountId: c.externalAccountId,
    config: c.config,
    hasCredentials: !!c.credentialsEncrypted,
    credentialsHint: c.credentialsHint,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

type EventInput = { type: string; level?: 'INFO' | 'WARN' | 'ERROR'; message: string; actorId?: string | null; correlationId?: string | null; data?: Record<string, unknown> };

// `tx` é o cliente da transação (ou o `prisma`): o evento entra junto da alteração que ele descreve.
async function logEvent(tx: { channelEvent: { create: (args: any) => Promise<unknown> } }, channel: Pick<SalesChannel, 'id' | 'companyId' | 'branchId'>, e: EventInput) {
  await tx.channelEvent.create({
    data: {
      companyId: channel.companyId,
      branchId: channel.branchId,
      channelId: channel.id,
      type: e.type,
      level: e.level ?? 'INFO',
      message: e.message.slice(0, 500),
      actorId: e.actorId ?? null,
      correlationId: e.correlationId ?? null,
      data: (e.data ?? undefined) as any,
    },
  });
}

/** Dica não reversível: só os 4 últimos caracteres do maior valor. */
function hintOf(values: string[]): string {
  const longest = values.reduce((a, b) => (b.length > a.length ? b : a), '');
  return longest.length >= 8 ? `••••${longest.slice(-4)}` : '••••';
}

export class SalesChannelService {
  private async find(companyId: string, id: string): Promise<SalesChannel> {
    const channel = await prisma.salesChannel.findFirst({ where: { id, companyId } });
    if (!channel) throw new AppError('Canal não encontrado', 404, 'CHANNEL_NOT_FOUND');
    return channel;
  }

  async list(companyId: string, filter: { branchId?: string | null } = {}): Promise<ChannelView[]> {
    const rows = await prisma.salesChannel.findMany({
      where: { companyId, ...(filter.branchId ? { OR: [{ branchId: filter.branchId }, { branchId: null }] } : {}) },
      orderBy: [{ createdAt: 'asc' }],
    });
    return rows.map(toView);
  }

  async get(companyId: string, id: string): Promise<ChannelView> {
    return toView(await this.find(companyId, id));
  }

  async create(input: { companyId: string; branchId?: string | null; type: SalesChannelType; displayName: string; actorId: string; provider?: string }): Promise<ChannelView> {
    const displayName = input.displayName.trim();
    // Provedor escolhido (Integration Gateway): só um registrado nesta instalação, e nunca para a loja física nem para o site próprio
    // (que chama o CÓRTEX pela Commerce API). Em produção o registro nasce vazio: nenhum provedor real existe antes da fase própria.
    if (input.provider !== undefined) {
      if (input.type === 'LOJA_FISICA' || input.type === 'SITE_PROPRIO') throw new AppError('Este tipo de canal não usa provedor de integração', 400, 'PROVIDER_NOT_APPLICABLE');
      if (!providerRegistry.has(input.provider)) throw new AppError('Provedor de integração não disponível nesta instalação', 400, 'PROVIDER_NOT_AVAILABLE');
    }
    if (displayName.length < 2 || displayName.length > 60) throw new AppError('O nome exibido deve ter de 2 a 60 caracteres', 400, 'INVALID_CHANNEL_NAME');
    const branchId = input.branchId ?? null;
    if (branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId: input.companyId }, select: { id: true } });
      if (!branch) throw new AppError('Filial não encontrada nesta empresa', 404, 'BRANCH_NOT_FOUND');
    }
    const duplicate = await prisma.salesChannel.findFirst({
      where: { companyId: input.companyId, branchId, type: input.type, displayName: { equals: displayName, mode: 'insensitive' } },
      select: { id: true },
    });
    if (duplicate) throw new AppError('Já existe um canal deste tipo com esse nome nesta empresa/filial', 409, 'CHANNEL_DUPLICATE');

    return runInTransaction(async (tx) => {
      const created = await tx.salesChannel.create({
        data: {
          companyId: input.companyId,
          branchId,
          type: input.type,
          displayName,
          // A loja física existe sempre (este registro só personaliza o nome); os demais nascem desativados.
          isActive: input.type === 'LOJA_FISICA',
          provider: input.provider ?? DEFAULT_PROVIDER[input.type],
          createdBy: input.actorId,
        },
      });
      await logEvent(tx as any, created, { type: 'CREATED', message: `Canal "${displayName}" (${input.type}) criado, desativado e sem conexão`, actorId: input.actorId });
      return toView(created);
    });
  }

  /** Tipo técnico, empresa e filial não mudam. Canal com provedor só ativa depois de um teste de conexão real bem-sucedido. */
  async update(input: {
    companyId: string;
    id: string;
    actorId: string;
    displayName?: string;
    isActive?: boolean;
    externalAccountId?: string | null;
    config?: Record<string, unknown> | null;
  }): Promise<ChannelView> {
    const channel = await this.find(input.companyId, input.id);
    const data: Record<string, unknown> = {};
    const changes: string[] = [];

    if (input.displayName !== undefined) {
      const name = input.displayName.trim();
      if (name.length < 2 || name.length > 60) throw new AppError('O nome exibido deve ter de 2 a 60 caracteres', 400, 'INVALID_CHANNEL_NAME');
      if (name !== channel.displayName) {
        data.displayName = name;
        changes.push('nome exibido');
      }
    }
    if (input.externalAccountId !== undefined) {
      data.externalAccountId = input.externalAccountId ? input.externalAccountId.trim().slice(0, 120) : null;
      changes.push('identificador externo');
    }
    if (input.config !== undefined) {
      data.config = (input.config ?? undefined) as any;
      changes.push('configuração');
    }
    if (input.isActive !== undefined && input.isActive !== channel.isActive) {
      if (channel.type === 'LOJA_FISICA' && !input.isActive) throw new AppError('A loja física não pode ser desativada', 409, 'CHANNEL_STORE_ALWAYS_ACTIVE');
      if (input.isActive && channel.provider && channel.connectionStatus !== 'CONNECTED') {
        throw new AppError('Este canal usa integração e só pode ser ativado depois de um teste de conexão bem-sucedido', 409, 'CHANNEL_NOT_VALIDATED');
      }
      data.isActive = input.isActive;
      changes.push(input.isActive ? 'ativado' : 'desativado');
    }
    if (changes.length === 0) return toView(channel);

    return runInTransaction(async (tx) => {
      const updated = await tx.salesChannel.update({ where: { id: channel.id }, data });
      await logEvent(tx as any, updated, {
        type: data.isActive === true ? 'ACTIVATED' : data.isActive === false ? 'DEACTIVATED' : 'UPDATED',
        message: `Canal alterado: ${changes.join(', ')}`,
        actorId: input.actorId,
      });
      return toView(updated);
    });
  }

  /** Grava a credencial CIFRADA (só escrita: a API nunca a devolve). Trocar a credencial exige novo teste de conexão. */
  async setCredentials(input: { companyId: string; id: string; actorId: string; credentials: Record<string, string> }): Promise<ChannelView> {
    const channel = await this.find(input.companyId, input.id);
    const entries = Object.entries(input.credentials ?? {});
    if (entries.length === 0 || entries.length > 10) throw new AppError('Informe de 1 a 10 campos de credencial', 400, 'INVALID_CREDENTIALS');
    for (const [k, v] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) || typeof v !== 'string' || v.length === 0 || v.length > 2000) {
        throw new AppError('Credencial inválida: nome do campo ou valor fora do padrão', 400, 'INVALID_CREDENTIALS');
      }
    }
    const sealed = sealSecret(JSON.stringify(Object.fromEntries(entries)));
    return runInTransaction(async (tx) => {
      const updated = await tx.salesChannel.update({
        where: { id: channel.id },
        data: {
          credentialsEncrypted: sealed,
          credentialsHint: hintOf(entries.map(([, v]) => v)),
          connectionStatus: 'UNVALIDATED',
          lastError: null,
          // credencial nova: o canal com integração deixa de operar até ser testado de novo
          ...(channel.provider ? { isActive: false } : {}),
        },
      });
      await logEvent(tx as any, updated, {
        type: 'CREDENTIALS_SET',
        message: `Credencial salva (campos: ${entries.map(([k]) => k).join(', ')}); conexão ainda não validada`,
        actorId: input.actorId,
      });
      return toView(updated);
    });
  }

  async clearCredentials(input: { companyId: string; id: string; actorId: string }): Promise<ChannelView> {
    const channel = await this.find(input.companyId, input.id);
    return runInTransaction(async (tx) => {
      const updated = await tx.salesChannel.update({
        where: { id: channel.id },
        data: { credentialsEncrypted: null, credentialsHint: null, connectionStatus: 'NOT_CONFIGURED', lastError: null, ...(channel.provider ? { isActive: false } : {}) },
      });
      await logEvent(tx as any, updated, { type: 'CREDENTIALS_CLEARED', message: 'Credencial removida', actorId: input.actorId });
      return toView(updated);
    });
  }

  /**
   * Teste de conexão. Sem provedor instalado, não chama nada e devolve `NO_PROVIDER` (o status não muda). Com provedor, a chamada
   * tem prazo, retentativa e disjuntor; só um `ok` do provedor grava CONNECTED.
   */
  async testConnection(input: { companyId: string; id: string; actorId: string; correlationId?: string }) {
    const channel = await this.find(input.companyId, input.id);
    const provider = providerRegistry.get(channel.provider);

    if (!provider) {
      await logEvent(prisma as any, channel, { type: 'CONNECTION_TEST', level: 'WARN', message: NO_PROVIDER_MESSAGE, actorId: input.actorId, correlationId: input.correlationId });
      return { ok: false as const, reason: 'NO_PROVIDER' as const, message: NO_PROVIDER_MESSAGE, channel: toView(channel) };
    }
    if (!channel.credentialsEncrypted) {
      await logEvent(prisma as any, channel, { type: 'CONNECTION_TEST', level: 'WARN', message: 'Teste não feito: o canal não tem credencial', actorId: input.actorId, correlationId: input.correlationId });
      return { ok: false as const, reason: 'NO_CREDENTIALS' as const, message: 'Cadastre a credencial antes de testar a conexão.', channel: toView(channel) };
    }

    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(openSecret(channel.credentialsEncrypted));
    } catch {
      throw new AppError('Não foi possível abrir a credencial salva; cadastre de novo', 409, 'CREDENTIALS_UNREADABLE');
    }
    const ctx: ChannelContext = {
      channelId: channel.id,
      companyId: channel.companyId,
      branchId: channel.branchId,
      provider: provider.key,
      externalAccountId: channel.externalAccountId,
      config: (channel.config as Record<string, unknown> | null) ?? null,
      credentials,
    };
    const result = await callProviderSafely(channel.id, () => provider.testConnection(ctx));

    const ok = result.ok && result.value.ok;
    const message = result.ok ? sanitizeErrorMessage(result.value.message) : result.message;
    const updated = await runInTransaction(async (tx) => {
      const row = await tx.salesChannel.update({
        where: { id: channel.id },
        data: ok ? { connectionStatus: 'CONNECTED', lastError: null } : { connectionStatus: 'ERROR', lastError: message, isActive: false },
      });
      await logEvent(tx as any, row, {
        type: 'CONNECTION_TEST',
        level: ok ? 'INFO' : 'ERROR',
        message: ok ? 'Teste de conexão bem-sucedido' : `Teste de conexão falhou: ${message}`,
        actorId: input.actorId,
        correlationId: input.correlationId,
      });
      return row;
    });
    return { ok, reason: ok ? ('OK' as const) : ('PROVIDER_ERROR' as const), message, channel: toView(updated) };
  }

  async listEvents(companyId: string, id: string, limit = 50) {
    await this.find(companyId, id);
    return prisma.channelEvent.findMany({
      where: { companyId, channelId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: { id: true, type: true, level: true, message: true, correlationId: true, actorId: true, createdAt: true },
    });
  }
}

export default new SalesChannelService();
