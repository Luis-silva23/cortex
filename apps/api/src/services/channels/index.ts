import { ChannelProvider, CollectionChannel } from './types';
import whatsappLinkProvider from './whatsapp-link.provider';
import emailNotConfiguredProvider from './email.provider';

export * from './types';
export { normalizeWhatsAppNumber } from './whatsapp-link.provider';

/**
 * Registro de provedores por canal. Padrão desta fase: WhatsApp = link click-to-chat (provisório); e-mail = não
 * configurado. Um provedor real (WhatsApp Business API oficial, SMTP) substitui o padrão chamando
 * `registerChannelProvider` no boot — o serviço de cobrança não muda.
 */
const defaults: Record<CollectionChannel, ChannelProvider> = {
  WHATSAPP: whatsappLinkProvider,
  EMAIL: emailNotConfiguredProvider,
};
const registered = new Map<CollectionChannel, ChannelProvider>();

export function registerChannelProvider(provider: ChannelProvider) {
  registered.set(provider.channel, provider);
}

/** Só para testes: volta aos provedores padrão. */
export function resetChannelProviders() {
  registered.clear();
}

export function providerFor(channel: CollectionChannel): ChannelProvider {
  return registered.get(channel) ?? defaults[channel];
}
