/**
 * Notificação de ALERTA por e-mail (Resend, opcional). A central de alertas interna é a fonte da verdade: este módulo só AVISA, e nunca derruba a avaliação de saúde.
 * Quando avisar: ao ABRIR, REABRIR ou ESCALAR para gravidade igual ou acima do mínimo (padrão CRITICAL; ALERT_EMAIL_MIN_SEVERITY=ATTENTION amplia). Atualização do
 * mesmo alerta já aberto NÃO avisa de novo. Tempestade: a mesma chave (tipo + alvo + gravidade) respeita a janela de deduplicação e há teto por hora/dia/mês
 * (resend.service). O texto leva só dados operacionais objetivos (tipo, alvo, valor, limite, desde quando): nenhum segredo, nenhum dado pessoal.
 */
import { prisma } from '@ln-system/database';
import { logger } from '../../utils/logger';
import { alertCategory, alertGuidance, severityRank } from './model';
import { recordAlertEvent } from './alert-events';
import { resendConfig, sendEmail } from './resend.service';
import { asPlatform } from './settings.service';

export type NotifyTrigger = 'OPENED' | 'REOPENED' | 'ESCALATED';

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
}

export function minSeverityRank(env: NodeJS.ProcessEnv = process.env): number {
  return env.ALERT_EMAIL_MIN_SEVERITY?.trim().toUpperCase() === 'ATTENTION' ? severityRank('ATTENTION') : severityRank('CRITICAL');
}

/** Chave de deduplicação: mesmo problema, mesmo alvo e mesma gravidade são a MESMA mensagem. */
export function alertDedupeKey(a: Pick<NotifiableAlert, 'type' | 'companyId' | 'branchId' | 'deviceId' | 'severity'>): string {
  return `alert:${a.type}:${a.companyId ?? 'central'}:${a.branchId ?? '-'}:${a.deviceId ?? '-'}:${a.severity}`;
}

export function composeAlertEmail(a: NotifiableAlert, trigger: NotifyTrigger, companyName: string | null, baseUrl: string | undefined) {
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

/** Avisa o alerta (se couber). NUNCA lança e nunca bloqueia: chamar sem `await` no caminho de avaliação. */
export async function notifyAlert(a: NotifiableAlert, trigger: NotifyTrigger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    if (severityRank(a.severity) < minSeverityRank(env)) return;
    if (!resendConfig(env).configured) return; // sem provedor autorizado: nada a fazer (e nenhuma consulta extra ao banco)
    const companyName = a.companyId
      ? ((await asPlatform(() => prisma.company.findUnique({ where: { id: a.companyId! }, select: { name: true } })))?.name ?? null)
      : null;
    const msg = composeAlertEmail(a, trigger, companyName, env.SUPER_ADMIN_URL);
    const result = await sendEmail({ ...msg, dedupeKey: alertDedupeKey(a), alertId: a.id }, { env });
    if (result.status === 'SENT') await recordAlertEvent({ alertId: a.id, companyId: a.companyId, kind: 'NOTIFIED', note: 'e-mail de alerta enviado' });
    else if (result.status === 'FAILED') await recordAlertEvent({ alertId: a.id, companyId: a.companyId, kind: 'NOTIFICATION_FAILED', note: String(result.reason ?? '').slice(0, 200) });
    else if (result.reason !== 'NOT_CONFIGURED' && result.reason !== 'DISABLED') {
      await recordAlertEvent({ alertId: a.id, companyId: a.companyId, kind: 'NOTIFICATION_SUPPRESSED', note: String(result.reason) });
    }
  } catch (error) {
    logger.warn('Notificação de alerta falhou (ignorada: o alerta interno segue válido)', { alertId: a.id, error: error instanceof Error ? error.message : String(error) });
  }
}
