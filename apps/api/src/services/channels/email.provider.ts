import { ChannelMessage, ChannelProvider, ChannelResult } from './types';

/**
 * E-mail sem provedor configurado: resultado NOT_CONFIGURED honesto (nunca "enviado").
 *
 * Ponto de integração: um provedor real (SMTP, SES, SendGrid…) implementa `ChannelProvider` com `channel: 'EMAIL'` e é
 * registrado com `registerChannelProvider(...)` no boot (ex.: quando `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/
 * `SMTP_FROM` estiverem definidos). Nenhum transporte SMTP está instalado neste build, então nada é inventado: mesmo com
 * `SMTP_HOST` definido, o resultado continua NOT_CONFIGURED e diz o porquê. Credenciais nunca vão para log nem para a
 * tabela de tentativas.
 */
export class EmailNotConfiguredProvider implements ChannelProvider {
  readonly name = 'email-not-configured';
  readonly channel = 'EMAIL' as const;

  async send(message: ChannelMessage): Promise<ChannelResult> {
    const smtpDeclared = !!process.env.SMTP_HOST;
    return {
      status: 'NOT_CONFIGURED',
      provider: this.name,
      recipient: message.to,
      providerMessage: smtpDeclared
        ? 'SMTP_HOST definido, mas nenhum transporte de e-mail está instalado/registrado neste servidor: e-mail NÃO enviado.'
        : 'Nenhum provedor de e-mail configurado: e-mail NÃO enviado. Configure um provedor (SMTP) para habilitar este canal.',
    };
  }
}

export default new EmailNotConfiguredProvider();
