/**
 * WhatsApp de alerta (queda crítica), SOMENTE por integração oficial: Meta WhatsApp Cloud API ou Twilio (parceiro autorizado). Mensagem iniciada pela empresa só pode usar MODELO
 * de mensagem aprovado pelo provedor: declaração explícita do operador em ALERT_WHATSAPP_TEMPLATE_APPROVED=true. Provedores prontos entram na ordem de ALERT_WHATSAPP_PROVIDERS
 * (padrão `meta,twilio`): se o primeiro falhar, o segundo é tentado (provedor alternativo). Faltou configuração: NÃO envia nada e a central de alertas interna segue normal.
 * "Enviado" aqui significa ACEITO pelo provedor; a confirmação de entrega/leitura (webhook) não está implementada.
 */
import { whatsappAttempts, whatsappConfig, type TransportDeps, type WhatsappConfig } from '@ln-system/shared/utils/alert-channels';
import { createBreaker, runChannel, type RunChannelResult } from './channel-core';

export const whatsappBreaker = createBreaker();

export { whatsappConfig };
export type { WhatsappConfig };

export interface SendWhatsappInput {
  text: string;
  dedupeKey: string;
  alertId?: string | null;
}

export interface SendDeps extends TransportDeps {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

export function sendWhatsapp(input: SendWhatsappInput, deps: SendDeps = {}): Promise<RunChannelResult> {
  const env = deps.env ?? process.env;
  const cfg = whatsappConfig(env);
  const t: TransportDeps = { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs };
  return runChannel({
    channel: 'WHATSAPP',
    configured: cfg.configured,
    enabled: true,
    recipients: cfg.to,
    dedupeKey: input.dedupeKey,
    alertId: input.alertId,
    breaker: whatsappBreaker,
    now: deps.now,
    sleep: deps.sleep,
    // provedores prontos, na ordem configurada (Meta, Twilio e/ou relé do Apps Script)
    attemptsFor: (to) => whatsappAttempts(env, to, input.text, `${input.dedupeKey}:${Math.floor((deps.now ?? new Date()).getTime() / 3_600_000)}`, t),
  });
}
