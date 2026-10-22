/**
 * Notificação de ALERTA por e-mail, SMS e WhatsApp (provedores opcionais). A central de alertas interna é a fonte da verdade: este módulo só AVISA, e nunca derruba a avaliação de saúde.
 * Quando avisar: ao ABRIR, REABRIR ou ESCALAR para gravidade igual ou acima do mínimo do CANAL (e-mail: padrão CRITICAL, ALERT_EMAIL_MIN_SEVERITY=ATTENTION amplia; SMS e WhatsApp: só
 * CRITICAL por padrão — custam por mensagem —, ALERT_SMS_MIN_SEVERITY / ALERT_WHATSAPP_MIN_SEVERITY=ATTENTION amplia) e, quando o problema VOLTA AO NORMAL, um aviso de RECUPERAÇÃO
 * só para os canais que haviam avisado o alerta (nenhuma recuperação "solta"). Atualização do mesmo alerta já aberto NÃO avisa de novo.
 * Os TRÊS canais são independentes: cada um decide sozinho (configuração, limites, deduplicação, disjuntor, provedor alternativo) e a falha de um não impede os outros
 * (`Promise.allSettled`, cada um com o seu try/catch). O texto leva só dados operacionais objetivos (tipo, alvo, valor, limite, desde quando): nenhum segredo, nenhum dado pessoal.
 */
import { prisma } from '@ln-system/database';
import { composeIncidentMessage, emailConfig, smsConfig, whatsappConfig } from '@ln-system/shared/utils/alert-channels';
import { logger } from '../../utils/logger';
import { alertCategory, alertGuidance, severityRank } from './model';
import { recordAlertEvent } from './alert-events';
import { resendConfig, sendEmail } from './resend.service';
import { sendSms } from './sms.service';
import { sendWhatsapp } from './whatsapp.service';
import { asPlatform } from './settings.service';
import type { DeliveryChannel } from './deliveries';

export type NotifyTrigger = 'OPENED' | 'REOPENED' | 'ESCALATED' | 'RECOVERED';

export interface NotifiableAlert {
  id: string;
  type: string;
  severity: string;
  companyId: string | null;
  branchId: string | null;
  deviceId: string | null;
  detail: string | null;
  value: number | null;
  threshold: number | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

type Channel = Exclude<DeliveryChannel, 'SENTRY'>;

const MIN_SEVERITY_VAR: Record<Channel, string> = { EMAIL: 'ALERT_EMAIL_MIN_SEVERITY', SMS: 'ALERT_SMS_MIN_SEVERITY', WHATSAPP: 'ALERT_WHATSAPP_MIN_SEVERITY' };

/** Gravidade mínima do CANAL (padrão CRITICAL em todos; ATTENTION só por escolha explícita). */
export function channelMinSeverityRank(channel: Channel, env: NodeJS.ProcessEnv = process.env): number {
  return env[MIN_SEVERITY_VAR[channel]]?.trim().toUpperCase() === 'ATTENTION' ? severityRank('ATTENTION') : severityRank('CRITICAL');
}

export function minSeverityRank(env: NodeJS.ProcessEnv = process.env): number {
  return channelMinSeverityRank('EMAIL', env);
}

/** Chave de deduplicação: mesmo problema, mesmo alvo e mesma gravidade são a MESMA mensagem. */
export function alertDedupeKey(a: Pick<NotifiableAlert, 'type' | 'companyId' | 'branchId' | 'deviceId' | 'severity'>): string {
  return `alert:${a.type}:${a.companyId ?? 'central'}:${a.branchId ?? '-'}:${a.deviceId ?? '-'}:${a.severity}`;
}

/** Recuperação: uma por episódio do alerta (a reincidência fecha de novo com outro instante de fim, logo outra chave). */
export function recoveryDedupeKey(a: Pick<NotifiableAlert, 'id' | 'endedAt'>): string {
  return `recovery:${a.id}:${a.endedAt ? a.endedAt.getTime() : 'now'}`;
}

function panelUrl(baseUrl: string | undefined): string | null {
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}/dashboard/observability/alertas` : null;
}

function composeRecovery(a: NotifiableAlert, companyName: string | null, baseUrl: string | undefined) {
  return composeIncidentMessage({
    phase: 'RECOVERED',
    severity: a.severity,
    target: companyName ? `empresa ${companyName}` : 'infraestrutura central',
    type: a.type,
    detail: a.detail,
    since: a.startedAt ?? null,
    durationMs: a.startedAt && a.endedAt ? a.endedAt.getTime() - a.startedAt.getTime() : null,
    source: 'central de monitoramento',
    panelUrl: panelUrl(baseUrl),
  });
}

export function composeAlertEmail(a: NotifiableAlert, trigger: NotifyTrigger, companyName: string | null, baseUrl: string | undefined) {
  if (trigger === 'RECOVERED') return composeRecovery(a, companyName, baseUrl);
  const verb = trigger === 'OPENED' ? 'Novo alerta' : trigger === 'REOPENED' ? 'Alerta reincidente' : 'Alerta agravado';
  const target = companyName ? `empresa ${companyName}` : 'infraestrutura central';
  const guidance = alertGuidance(a.type);
  const lines = [
    `${verb} ${a.severity} — ${alertCategory(a.type)} (${a.type})`,
    `Alvo: ${target}`,
    a.detail ? `Detalhe: ${a.detail}` : null,
    a.value !== null && a.threshold !== null ? `Valor: ${a.value} (limite: ${a.threshold})` : null,
    guidance ? `Orientação: ${guidance}` : null,
    baseUrl ? `Central de alertas: ${baseUrl.replace(/\/+$/, '')}/dashboard/observability/alertas` : null,
    '',
    'Mensagem automática do monitoramento do CÓRTEX. Não responda este e-mail.',
  ].filter((l): l is string => l !== null);
  return { subject: `[CÓRTEX] ${a.severity} · ${a.type} · ${companyName ?? 'central'}`, text: lines.join('\n') };
}

/** Texto curto para SMS/WhatsApp (uma mensagem; o transporte ainda o normaliza e limita). */
export function composeShortAlert(a: NotifiableAlert, trigger: NotifyTrigger, companyName: string | null, baseUrl: string | undefined): string {
  if (trigger === 'RECOVERED') return composeRecovery(a, companyName, baseUrl).text;
  return composeIncidentMessage({
    phase: trigger === 'ESCALATED' ? 'ESCALATED' : 'OPEN',
    severity: a.severity,
    target: companyName ? `empresa ${companyName}` : 'infraestrutura central',
    type: a.type,
    detail: a.detail,
    since: a.startedAt ?? null,
    source: 'central de monitoramento',
    panelUrl: panelUrl(baseUrl),
  }).text;
}

interface Dispatch {
  channel: Channel;
  label: string;
  send: () => Promise<{ status: 'SENT' | 'FAILED' | 'SUPPRESSED'; reason?: string }>;
}

/** O canal já avisou este alerta antes (aceito pelo provedor)? Só então a recuperação é avisada. */
async function previouslyNotified(channel: Channel, alertId: string): Promise<boolean> {
  const n = await asPlatform(() => prisma.externalDelivery.count({ where: { channel, alertId, status: 'SENT' } }));
  return n > 0;
}

async function record(a: NotifiableAlert, d: Dispatch, r: { status: string; reason?: string }): Promise<void> {
  if (r.status === 'SENT') await recordAlertEvent({ alertId: a.id, companyId: a.companyId, kind: 'NOTIFIED', note: `${d.label} de alerta enviado (aceito pelo provedor)` });
  else if (r.status === 'FAILED') await recordAlertEvent({ alertId: a.id, companyId: a.companyId, kind: 'NOTIFICATION_FAILED', note: `${d.label}: ${String(r.reason ?? '').slice(0, 180)}` });
  else if (r.reason !== 'NOT_CONFIGURED' && r.reason !== 'DISABLED') await recordAlertEvent({ alertId: a.id, companyId: a.companyId, kind: 'NOTIFICATION_SUPPRESSED', note: `${d.label}: ${r.reason}` });
}

/** Avisa o alerta (se couber) por TODOS os canais configurados, de forma independente. NUNCA lança e nunca bloqueia: chamar sem `await` no caminho de avaliação. */
export async function notifyAlert(a: NotifiableAlert, trigger: NotifyTrigger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const recovered = trigger === 'RECOVERED';
    const ready: Channel[] = [];
    // verificação barata, sem banco: só segue quem tem configuração completa; na recuperação não há piso de gravidade (vale quem já avisou)
    if (resendConfig(env).configured && (recovered || severityRank(a.severity) >= channelMinSeverityRank('EMAIL', env))) ready.push('EMAIL');
    if (smsConfig(env).configured && (recovered || severityRank(a.severity) >= channelMinSeverityRank('SMS', env))) ready.push('SMS');
    if (whatsappConfig(env).configured && (recovered || severityRank(a.severity) >= channelMinSeverityRank('WHATSAPP', env))) ready.push('WHATSAPP');
    if (ready.length === 0) return; // nenhum provedor autorizado/gravidade suficiente: nada a fazer (e nenhuma consulta ao banco)

    const companyName = a.companyId ? ((await asPlatform(() => prisma.company.findUnique({ where: { id: a.companyId! }, select: { name: true } })))?.name ?? null) : null;
    const baseUrl = env.SUPER_ADMIN_URL;
    const key = recovered ? recoveryDedupeKey(a) : alertDedupeKey(a);
    const email = composeAlertEmail(a, trigger, companyName, baseUrl);
    const short = composeShortAlert(a, trigger, companyName, baseUrl);
    const all: Dispatch[] = [
      { channel: 'EMAIL', label: 'e-mail', send: () => sendEmail({ ...email, dedupeKey: key, alertId: a.id }, { env }) },
      { channel: 'SMS', label: 'SMS', send: () => sendSms({ text: short, dedupeKey: key, alertId: a.id }, { env }) },
      { channel: 'WHATSAPP', label: 'WhatsApp', send: () => sendWhatsapp({ text: short, dedupeKey: key, alertId: a.id }, { env }) },
    ];
    const wanted = all.filter((d) => ready.includes(d.channel));

    // cada canal em seu próprio try/catch: nenhuma falha (provedor fora, banco, exceção) impede os outros
    await Promise.allSettled(
      wanted.map(async (d) => {
        try {
          if (recovered && !(await previouslyNotified(d.channel, a.id))) return;
          await record(a, d, await d.send());
        } catch (error) {
          logger.warn('Notificação de alerta falhou em um canal (os outros seguem)', { alertId: a.id, channel: d.channel, error: error instanceof Error ? error.message : String(error) });
        }
      })
    );
  } catch (error) {
    logger.warn('Notificação de alerta falhou (ignorada: o alerta interno segue válido)', { alertId: a.id, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Estado de configuração dos três canais para a tela (sem valores, sem números: só o que falta). */
export function channelsStatus(env: NodeJS.ProcessEnv = process.env) {
  const e = emailConfig(env);
  const s = smsConfig(env);
  const w = whatsappConfig(env);
  const min = (c: Channel) => (channelMinSeverityRank(c, env) === severityRank('ATTENTION') ? 'ATTENTION' : 'CRITICAL');
  return {
    EMAIL: { configured: e.configured, missing: e.missing, recipients: e.to.length, minSeverity: min('EMAIL') },
    SMS: { configured: s.configured, missing: s.missing, recipients: s.to.length, invalidRecipients: s.invalidRecipients, providers: s.providers, minSeverity: min('SMS') },
    WHATSAPP: { configured: w.configured, missing: w.missing, recipients: w.to.length, invalidRecipients: w.invalidRecipients, providers: w.providers, minSeverity: min('WHATSAPP') },
  };
}
