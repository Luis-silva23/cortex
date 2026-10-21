/**
 * RETENÇÃO da telemetria da Central (roda no job diário `cleanup-old-logs`): amostras de saúde e entregas externas vencidas saem; alertas ENCERRADOS há mais que
 * MONITORING_ALERT_RETENTION_DAYS saem com o histórico deles (o histórico é append-only: o DELETE só passa com o expurgo sinalizado, em contexto de Super Admin, na
 * mesma transação). Funil comercial, ajustes e alertas abertos NÃO são apagados por retenção. Nunca lança.
 */
import { prisma, runInTransaction } from '@ln-system/database';
import { logger } from '../../utils/logger';
import { asPlatform, envRetention } from './settings.service';

export async function purgeMonitoringTelemetry(now = new Date(), env: NodeJS.ProcessEnv = process.env) {
  try {
    const r = envRetention(env);
    const cut = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const result = await asPlatform(async () => {
      const samples = await prisma.serviceHealthSample.deleteMany({ where: { sampledAt: { lt: cut(r.sampleDays) } } });
      const deliveries = await prisma.externalDelivery.deleteMany({ where: { createdAt: { lt: cut(r.deliveryDays) } } });
      const old = await prisma.monitoringAlert.findMany({ where: { endedAt: { lt: cut(r.alertDays) } }, select: { id: true }, take: 5000 });
      let alerts = 0;
      let events = 0;
      if (old.length > 0) {
        const ids = old.map((a) => a.id);
        const done = await runInTransaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
          const e = await tx.monitoringAlertEvent.deleteMany({ where: { alertId: { in: ids } } });
          const a = await tx.monitoringAlert.deleteMany({ where: { id: { in: ids }, endedAt: { not: null } } });
          return { alerts: a.count, events: e.count };
        });
        alerts = done.alerts;
        events = done.events;
      }
      return { samples: samples.count, deliveries: deliveries.count, alerts, alertEvents: events };
    });
    if (result.samples || result.deliveries || result.alerts) logger.info('Telemetria da Central de Monitoramento depurada', result);
    return result;
  } catch (error) {
    logger.error('Falha ao depurar a telemetria da Central de Monitoramento (ignorada)', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
