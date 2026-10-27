/**
 * SMS de alerta (queda crítica). Provedor: Twilio (entrega no Brasil; o remetente precisa estar REGISTRADO/autorizado para o Brasil — declaração explícita do operador em
 * ALERT_SMS_SENDER_VERIFIED=true). Só envia com configuração completa; faltou qualquer item: NÃO envia nada e a central de alertas interna segue normal.
 * Limites por hora/dia/mês, deduplicação, disjuntor e registro vêm do núcleo comum (`channel-core`). "Enviado" aqui significa ACEITO pelo provedor, não entregue no aparelho.
 */
import { smsAttempts, smsConfig, type SmsConfig, type TransportDeps } from '@ln-system/shared/utils/alert-channels';
import { createBreaker, runChannel, type RunChannelResult } from './channel-core';

export const smsBreaker = createBreaker();

export { smsConfig };
export type { SmsConfig };

export interface SendSmsInput {
  text: string;
  dedupeKey: string;
  alertId?: string | null;
}

export interface SendDeps extends TransportDeps {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

export function sendSms(input: SendSmsInput, deps: SendDeps = {}): Promise<RunChannelResult> {
  const env = deps.env ?? process.env;
  const cfg = smsConfig(env);
  return runChannel({
    channel: 'SMS',
    configured: cfg.configured,
    enabled: true,
    recipients: cfg.to,
    dedupeKey: input.dedupeKey,
    alertId: input.alertId,
    breaker: smsBreaker,
    now: deps.now,
    sleep: deps.sleep,
    // provedores prontos: Twilio direto e/ou relé do Apps Script (id estável por notificação e hora: a repetição volta como `duplicate`, sem reenviar)
    attemptsFor: (to) => smsAttempts(env, to, input.text, `${input.dedupeKey}:${Math.floor((deps.now ?? new Date()).getTime() / 3_600_000)}`, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs }),
  });
}
