import { prisma, runWithRLSContext } from '@ln-system/database';
import { openSecret } from '@ln-system/shared/utils/secret-box';
import moduleSettingsService from '../module-settings.service';
import { Logger } from '../logger.service';
import { gatewayBreaker, providerRegistry, sanitizeErrorMessage, withTimeout, type ChannelContext } from '../sales-channels/gateway';
import { classifyFailure } from './outbox.service';
import { processEvents } from './inbound.service';

/**
 * CONSULTA PERIÓDICA ao provedor (Integration Gateway): cobre o webhook que não chegou (docs/CORTEX/COMMERCE_API.md §12). Só canais
 * ATIVOS e CONECTADOS cujo provedor implementa `pollEvents`. Cada consulta tem prazo e disjuntor por canal; os eventos devolvidos
 * passam pelo MESMO processamento do webhook (esquema fechado, idempotência por evento, fora de ordem), então um evento que chegou
 * pelos dois caminhos é tratado uma vez só. O cursor só avança se NENHUM evento do lote falhou por causa nossa: o resto é reenviado.
 */
const POLL_TIMEOUT_MS = 8_000;
const MAX_EVENTS = 100;

export async function pollChannels(limit = 20, now = new Date(), onlyChannelId?: string) {
  const channels = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, () =>
    prisma.salesChannel.findMany({ where: { ...(onlyChannelId ? { id: onlyChannelId } : {}), isActive: true, connectionStatus: 'CONNECTED', provider: { not: null }, branchId: { not: null } }, orderBy: { lastSyncAt: { sort: 'asc', nulls: 'first' } }, take: limit })
  );
  const summary = { channels: 0, events: 0, failures: 0, skipped: 0 };

  for (const channel of channels) {
    const provider = providerRegistry.get(channel.provider);
    if (!provider?.pollEvents || !channel.branchId) continue;
    if (!gatewayBreaker.canCall(channel.id, now.getTime())) {
      summary.skipped += 1;
      continue;
    }
    summary.channels += 1;
    try {
      await runWithRLSContext({ companyId: channel.companyId, userType: 'SUPER_ADMIN', branchId: null }, async () => {
        if (!(await moduleSettingsService.isModuleEnabled(channel.companyId, channel.branchId, 'CANAIS'))) return;
        let credentials: Record<string, string> | null = null;
        if (channel.credentialsEncrypted) credentials = JSON.parse(openSecret(channel.credentialsEncrypted));
        const ctx: ChannelContext = { channelId: channel.id, companyId: channel.companyId, branchId: channel.branchId, provider: provider.key, externalAccountId: channel.externalAccountId, config: (channel.config as Record<string, unknown> | null) ?? null, credentials };

        let page;
        try {
          page = await withTimeout(provider.pollEvents!(ctx, channel.inboundCursor), POLL_TIMEOUT_MS);
          gatewayBreaker.success(channel.id);
        } catch (err) {
          const f = classifyFailure(err);
          if (f.kind === 'AUTH') {
            await prisma.salesChannel.update({ where: { id: channel.id }, data: { connectionStatus: 'ERROR', lastError: f.message, isActive: false } });
            await prisma.channelEvent.create({ data: { companyId: channel.companyId, branchId: channel.branchId, channelId: channel.id, type: 'PROVIDER_AUTH_FAILED', level: 'ERROR', message: 'O provedor recusou a credencial na consulta periódica: canal em erro', data: {} as any } });
          } else {
            if (f.kind !== 'RATE_LIMIT') gatewayBreaker.failure(channel.id, now.getTime());
            await prisma.salesChannel.update({ where: { id: channel.id }, data: { lastError: f.message } });
          }
          summary.failures += 1;
          return;
        }

        const events = (page.events ?? []).slice(0, MAX_EVENTS);
        if (events.length > 0) {
          const results = await runWithRLSContext({ companyId: channel.companyId, branchId: channel.branchId, userType: 'CHANNEL' }, () =>
            processEvents({ id: channel.id, companyId: channel.companyId, branchId: channel.branchId, provider: channel.provider, config: channel.config }, events, { correlationId: `poll-${channel.id}-${now.getTime()}` })
          );
          summary.events += results.length;
          if (results.some((r) => r.outcome === 'FAILED')) {
            summary.failures += 1;
            return; // não avança o cursor: o lote é entregue de novo e cada evento é idempotente
          }
        }
        await prisma.salesChannel.update({ where: { id: channel.id }, data: { inboundCursor: page.nextCursor, lastSyncAt: now, lastError: null } });
      });
    } catch (err) {
      summary.failures += 1;
      Logger.error('Falha na consulta periódica de um canal', new Error(sanitizeErrorMessage(err)));
    }
  }
  return summary;
}
