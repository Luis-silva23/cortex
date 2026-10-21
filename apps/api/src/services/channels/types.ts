/**
 * Camada de canal da cobrança (docs/CORTEX/policies/COBRANCA.md). O financeiro não conhece o mecanismo de envio: pede a
 * um provedor registrado para o canal. Mesmo desenho de `payment-adapters/` — um provedor real entra registrando-se,
 * sem mudar o serviço de cobrança.
 *
 * Resultado honesto: nenhum provedor devolve SENT sem ter de fato entregue a mensagem a um serviço de envio.
 *  - SENT            provedor real aceitou a mensagem (ex.: SMTP/API oficial do WhatsApp — nenhum configurado hoje)
 *  - LINK_GENERATED  WhatsApp provisório: link click-to-chat gerado; quem envia é o usuário, no próprio WhatsApp
 *  - NOT_CONFIGURED  não há provedor configurado para o canal (ex.: e-mail sem SMTP)
 *  - FAILED          não foi possível (destinatário ausente/inválido, erro do provedor)
 */
export type CollectionChannel = 'WHATSAPP' | 'EMAIL';
export type ChannelStatus = 'SENT' | 'LINK_GENERATED' | 'FAILED' | 'NOT_CONFIGURED';

export interface ChannelMessage {
  /** Número (WhatsApp) ou e-mail do destinatário. */
  to: string | null;
  subject: string;
  text: string;
}

export interface ChannelResult {
  status: ChannelStatus;
  provider: string;
  /** Mensagem legível do resultado (vai para collection_attempts.providerMessage). Sem segredo. */
  providerMessage: string;
  /** Destinatário normalizado efetivamente usado. */
  recipient: string | null;
  /** WhatsApp provisório: link a abrir no navegador do usuário. */
  link?: string;
}

export interface ChannelProvider {
  readonly name: string;
  readonly channel: CollectionChannel;
  send(message: ChannelMessage): Promise<ChannelResult>;
}
