import { ChannelMessage, ChannelProvider, ChannelResult } from './types';

/**
 * WhatsApp — mecanismo PROVISÓRIO desta fase (sem API oficial): gera o link click-to-chat
 * `https://wa.me/<número>?text=<mensagem>` para a tela abrir; o próprio usuário envia pelo WhatsApp dele. Nada sai do
 * servidor e nada é enviado sem essa ação humana. Resultado: LINK_GENERATED (nunca SENT — o CÓRTEX não sabe se a
 * pessoa enviou). O provedor oficial (WhatsApp Business API) entra no mesmo registro, substituindo este.
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`; // número brasileiro com DDD, sem o país
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return null;
}

export class WhatsAppLinkProvider implements ChannelProvider {
  readonly name = 'whatsapp-click-to-chat';
  readonly channel = 'WHATSAPP' as const;

  async send(message: ChannelMessage): Promise<ChannelResult> {
    if (!message.to) {
      return { status: 'FAILED', provider: this.name, recipient: null, providerMessage: 'Sem número de WhatsApp/telefone cadastrado para o devedor' };
    }
    const number = normalizeWhatsAppNumber(message.to);
    if (!number) {
      return { status: 'FAILED', provider: this.name, recipient: message.to, providerMessage: 'Número de WhatsApp inválido (use DDD + número)' };
    }
    return {
      status: 'LINK_GENERATED',
      provider: this.name,
      recipient: number,
      link: `https://wa.me/${number}?text=${encodeURIComponent(message.text)}`,
      providerMessage: 'Link do WhatsApp gerado. O envio é feito pelo usuário no próprio WhatsApp (sem API oficial nesta fase).',
    };
  }
}

export default new WhatsAppLinkProvider();
