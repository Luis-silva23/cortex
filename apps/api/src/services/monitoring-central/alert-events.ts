/**
 * Histórico de tratamento do alerta (monitoring_alert_events): quem, quando e o quê. Append-only no banco (sem UPDATE; DELETE só com expurgo sinalizado).
 * Gravar o histórico NUNCA derruba a avaliação de saúde: em falha, registra no log e segue.
 */
import { prisma } from '@ln-system/database';
import { logger } from '../../utils/logger';
import { asPlatform } from './settings.service';

export type AlertEventKind =
  | 'OPENED'
  | 'REOPENED'
  | 'SEVERITY_CHANGED'
  | 'ACKNOWLEDGED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'AUTO_RESOLVED'
  | 'NOTE'
  | 'NOTIFIED'
  | 'NOTIFICATION_SUPPRESSED'
  | 'NOTIFICATION_FAILED';

export interface AlertEventInput {
  alertId: string;
  companyId?: string | null;
  kind: AlertEventKind;
  actorId?: string | null;
  note?: string | null;
}

export async function recordAlertEvent(e: AlertEventInput): Promise<void> {
  try {
    await asPlatform(() =>
      prisma.monitoringAlertEvent.create({
        data: { alertId: e.alertId, companyId: e.companyId ?? null, kind: e.kind, actorId: e.actorId ?? null, note: e.note ? e.note.slice(0, 500) : null },
      })
    );
  } catch (error) {
    logger.warn('Falha ao gravar o histórico do alerta (ignorada)', { alertId: e.alertId, kind: e.kind, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function listAlertEvents(alertId: string, limit = 100) {
  return asPlatform(() => prisma.monitoringAlertEvent.findMany({ where: { alertId }, orderBy: { createdAt: 'asc' }, take: Math.min(limit, 500) }));
}
