/**
 * COLETOR da Central de Monitoramento — roda dentro do job `evaluate-health` (a cada minuto) mas só COLETA no intervalo configurado (MONITORING_SAMPLE_MINUTES, padrão 5):
 *   • grava uma amostra por serviço (API, banco, Redis, filas, CPU/memória/disco do servidor, backup) em service_health_samples — base dos gráficos de disponibilidade;
 *   • avalia as condições CENTRAIS que ainda não eram alertas (servidor, backup, integrações por empresa, falha de entrega de e-mail/Sentry) pelo MESMO mecanismo de alertas
 *     (um aberto por tipo+alvo, reincidência reabre, histórico e aviso nas mudanças).
 * Custo: poucas consultas agregadas por rodada (nada por requisição de usuário); o teto diário de amostras e o interruptor `sampling` desligam só a TELEMETRIA — os alertas críticos
 * continuam sendo avaliados. Nunca lança para o job: monitorar não derruba nada.
 */
import * as os from 'os';
import * as fs from 'fs/promises';
import { Prisma } from '@prisma/client';
import { prisma } from '@ln-system/database';
import { logger } from '../../utils/logger';
import monitoringService, { type AlertCondition } from '../monitoring.service';
import monitoringThresholds from '../monitoring-thresholds.service';
import { level, worst, type HealthStatus } from '../health-status';
import { asPlatform, getEffective, rawQuery } from './settings.service';
import { readBackupStatus } from './backup-status';
import { deliverySummary } from './deliveries';
import { externalMonitorState, staleMinutes } from './external-monitor.service';
import { classifyIntegrations, integrationSummary } from './model';
import { companiesSnapshot, loadIntegrationInputs } from './overview.service';

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Leitura do servidor (onde a API roda: em contêiner, é o limite do contêiner/host que o sistema operacional informa)
// ---------------------------------------------------------------------------------------------------------------------------------------------
let cpuPrev: { idle: number; total: number } | null = null;

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/** CPU do servidor desde a leitura anterior (%). A primeira leitura do processo não tem referência: devolve null (sem dado), nunca zero inventado. */
export function readCpuPct(): number | null {
  const now = cpuSnapshot();
  const prev = cpuPrev;
  cpuPrev = now;
  if (!prev) return null;
  const total = now.total - prev.total;
  const idle = now.idle - prev.idle;
  if (total <= 0) return null;
  return Math.round((1 - idle / total) * 1000) / 10;
}

export function readMemPct(): number {
  const total = os.totalmem();
  return Math.round(((total - os.freemem()) / total) * 1000) / 10;
}

export async function readDiskPct(dir = process.cwd()): Promise<number | null> {
  try {
    const s = await fs.statfs(dir);
    if (!s.blocks) return null;
    return Math.round((1 - Number(s.bavail) / Number(s.blocks)) * 1000) / 10;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
let lastRunAt = 0;
export function __resetSampler() {
  lastRunAt = 0;
  cpuPrev = null;
}

async function isDue(now: Date, intervalMs: number): Promise<boolean> {
  // folga de 10% para o relógio do job (a cada minuto) não pular uma rodada por milissegundos
  const recent = (ageMs: number) => ageMs >= 0 && ageMs < intervalMs * 0.9; // relógio que anda para trás não trava a coleta
  if (lastRunAt && recent(now.getTime() - lastRunAt)) return false;
  if (!lastRunAt) {
    // primeira rodada deste processo: respeita a última amostra gravada (reinício da API não duplica a coleta)
    const last = await asPlatform(() => prisma.serviceHealthSample.findFirst({ orderBy: { sampledAt: 'desc' }, select: { sampledAt: true } }));
    if (last && recent(now.getTime() - last.sampledAt.getTime())) {
      lastRunAt = last.sampledAt.getTime();
      return false;
    }
  }
  return true;
}

interface SampleRow {
  service: string;
  status: HealthStatus;
  latencyMs?: number | null;
  valuePct?: number | null;
  detail?: string | null;
}

const cond = (base: Omit<AlertCondition, 'source' | 'companyId' | 'branchId' | 'deviceId'> & Partial<Pick<AlertCondition, 'source' | 'companyId'>>): AlertCondition => ({
  source: 'CENTRAL',
  companyId: null,
  branchId: null,
  deviceId: null,
  ...base,
});

export async function runCentralEvaluation(now = new Date()) {
  try {
    const effective = await getEffective();
    if (!effective.toggles.sampling) return { skipped: 'sampling_disabled' as const };
    const intervalMs = effective.limits.sampleMinutes * 60_000;
    if (!(await isDue(now, intervalMs))) return { skipped: 'not_due' as const };
    lastRunAt = now.getTime();

    const t = await monitoringThresholds.effective(null);
    const central = await monitoringService.centralHealth(t);
    const [cpu, mem, disk] = [readCpuPct(), readMemPct(), await readDiskPct()];
    const windowStart = new Date(now.getTime() - Math.max(intervalMs, 60_000));
    const api = await asPlatform(() =>
      rawQuery<Array<{ total: bigint; errors: bigint; p95: number | null }>>(Prisma.sql`
        SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE "statusCode" >= 500) AS errors, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95
        FROM request_logs WHERE "createdAt" >= ${windowStart} AND "createdAt" <= ${now}`)
    );
    const requests = Number(api[0]?.total ?? 0);
    const errorPct = requests > 0 ? Math.round((Number(api[0]?.errors ?? 0) / requests) * 1000) / 10 : null;
    const p95 = requests > 0 && api[0]?.p95 != null ? Math.round(Number(api[0].p95)) : null;
    const backup = await readBackupStatus(process.env, now);

    const samples: SampleRow[] = [
      { service: 'DATABASE', status: central.database.status, latencyMs: central.database.latencyMs },
      { service: 'REDIS', status: central.redis.status, latencyMs: central.redis.latencyMs },
      { service: 'QUEUES', status: central.queues.status, valuePct: null, detail: `aguardando ${central.queues.waiting} · falhas/h ${central.queues.failedLastHour} · atrasados ${central.queues.overdue}` },
      { service: 'HOST_CPU', status: level(cpu, t.cpuPct), valuePct: cpu },
      { service: 'HOST_MEMORY', status: level(mem, t.memPct), valuePct: mem },
      { service: 'HOST_DISK', status: level(disk, t.diskPct), valuePct: disk },
    ];
    if (requests > 0) samples.push({ service: 'API', status: worst(level(p95, t.apiP95Ms), level(errorPct, t.api5xxPct)), latencyMs: p95, valuePct: errorPct, detail: `${requests} requisições na janela` });
    if (backup.configured) samples.push({ service: 'BACKUP', status: backup.status, valuePct: null, detail: backup.level });

    // amostra DIÁRIA do número de empresas (a série histórica de empresas ativas só existe a partir da coleta)
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [samplesToday, companiesToday] = await asPlatform(() =>
      Promise.all([
        prisma.serviceHealthSample.count({ where: { sampledAt: { gte: startOfDay } } }),
        prisma.serviceHealthSample.count({ where: { service: 'COMPANIES', sampledAt: { gte: startOfDay } } }),
      ])
    );
    let written = 0;
    let capped = false;
    if (samplesToday + samples.length <= effective.limits.samplesMaxPerDay) {
      const rows = [...samples];
      if (companiesToday === 0) {
        const snap = await companiesSnapshot();
        rows.push({ service: 'COMPANIES', status: 'NORMAL', valuePct: snap.active, detail: JSON.stringify(snap) });
      }
      await asPlatform(() =>
        prisma.serviceHealthSample.createMany({
          data: rows.map((r) => ({ sampledAt: now, service: r.service, status: r.status, latencyMs: r.latencyMs ?? null, valuePct: r.valuePct ?? null, detail: r.detail ?? null })),
        })
      );
      written = rows.length;
    } else {
      capped = true; // teto diário de telemetria: some só a TELEMETRIA; os alertas abaixo continuam
      logger.warn('Coleta de amostras suspensa: teto diário de telemetria atingido', { max: effective.limits.samplesMaxPerDay });
    }

    // ---- alertas centrais ----
    const conditions: AlertCondition[] = [
      cond({ type: 'SERVER_CPU', metric: 'cpuPct', value: cpu, threshold: t.cpuPct, status: level(cpu, t.cpuPct), detail: `CPU do servidor ${cpu ?? '—'}%` }),
      cond({ type: 'SERVER_MEMORY', metric: 'memPct', value: mem, threshold: t.memPct, status: level(mem, t.memPct), detail: `RAM do servidor ${mem}%` }),
      cond({ type: 'SERVER_DISK', metric: 'diskPct', value: disk, threshold: t.diskPct, status: level(disk, t.diskPct), detail: `disco do servidor ${disk ?? '—'}%` }),
    ];
    if (backup.configured) {
      const max = backup.maxAgeHours;
      const stale: HealthStatus = backup.lastCreatedAt === null ? 'CRITICAL' : (backup.ageHours ?? 0) > max * 2 ? 'CRITICAL' : (backup.ageHours ?? 0) > max ? 'ATTENTION' : 'NORMAL';
      conditions.push(
        cond({ type: 'BACKUP_STALE', metric: 'backupAgeHours', value: backup.ageHours, threshold: { attention: max, critical: max * 2 }, status: stale, detail: backup.lastCreatedAt ? `último backup há ${backup.ageHours} h` : 'nenhum backup com manifesto' }),
        cond({
          type: 'BACKUP_VERIFY_FAILED',
          metric: 'backupVerify',
          value: null,
          threshold: null,
          status: backup.lastVerify.state === 'falha' ? 'CRITICAL' : backup.lastVerify.state === 'ok' ? 'NORMAL' : 'NO_DATA',
          detail: backup.lastVerify.detail ?? 'a verificação do backup falhou',
        })
      );
    }
    // falha de entrega de notificações externas (só quando o provedor está em uso): o alerta interno continua sendo a fonte da verdade
    const [emailD, sentryD] = await Promise.all([deliverySummary('EMAIL', now), deliverySummary('SENTRY', now)]);
    const failing = (n: number): HealthStatus => (n >= 5 ? 'CRITICAL' : n >= 3 ? 'ATTENTION' : 'NORMAL');
    if (emailD.sent.month > 0 || emailD.failed24h > 0) conditions.push(cond({ type: 'EMAIL_DELIVERY_FAILING', metric: 'emailFailed24h', value: emailD.failed24h, threshold: { attention: 3, critical: 5 }, status: failing(emailD.failed24h), detail: `${emailD.failed24h} falha(s) de e-mail nas últimas 24 h` }));
    const [smsD, waD] = await Promise.all([deliverySummary('SMS', now), deliverySummary('WHATSAPP', now)]);
    if (smsD.sent.month > 0 || smsD.failed24h > 0) conditions.push(cond({ type: 'SMS_DELIVERY_FAILING', metric: 'smsFailed24h', value: smsD.failed24h, threshold: { attention: 3, critical: 5 }, status: failing(smsD.failed24h), detail: `${smsD.failed24h} falha(s) de SMS nas últimas 24 h` }));
    if (waD.sent.month > 0 || waD.failed24h > 0) conditions.push(cond({ type: 'WHATSAPP_DELIVERY_FAILING', metric: 'whatsappFailed24h', value: waD.failed24h, threshold: { attention: 3, critical: 5 }, status: failing(waD.failed24h), detail: `${waD.failed24h} falha(s) de WhatsApp nas últimas 24 h` }));
    // o monitor externo é a única visão "de fora": se ele já reportou alguma vez e calou, o painel avisa (a ausência de relato NÃO é "tudo bem")
    const ext = await externalMonitorState(now);
    if (ext.enabled && ext.everReported) {
      const age = ext.ageMinutes ?? 0;
      const limit = staleMinutes();
      conditions.push(cond({ type: 'EXTERNAL_MONITOR_STALE', metric: 'externalMonitorAgeMin', value: age, threshold: { attention: limit, critical: limit * 3 }, status: age >= limit * 3 ? 'CRITICAL' : age >= limit ? 'ATTENTION' : 'NORMAL', detail: `monitor externo sem relatar há ${age} min` }));
    }
    if (sentryD.sent.month > 0 || sentryD.failed24h > 0) conditions.push(cond({ type: 'SENTRY_DELIVERY_FAILING', metric: 'sentryFailed24h', value: sentryD.failed24h, threshold: { attention: 3, critical: 5 }, status: failing(sentryD.failed24h), detail: `${sentryD.failed24h} falha(s) de envio ao Sentry nas últimas 24 h` }));

    // integrações por empresa (conexão testada e falha de entrega): ERRO → crítico; degradada → atenção
    const perCompany = await loadIntegrationInputs();
    for (const [companyId, inputs] of perCompany) {
      const items = classifyIntegrations(inputs);
      const s = integrationSummary(items);
      const bad = items.filter((i) => i.state === 'ERROR' || i.state === 'DEGRADED').slice(0, 3).map((i) => `${i.label}: ${i.reason}`);
      conditions.push(
        cond({
          source: 'COMPANY',
          companyId,
          type: 'INTEGRATION_HEALTH',
          metric: 'integrationHealth',
          value: s.healthPct,
          threshold: null,
          status: s.error > 0 ? 'CRITICAL' : s.degraded > 0 ? 'ATTENTION' : s.verified > 0 ? 'NORMAL' : 'NO_DATA',
          detail: bad.length ? bad.join(' · ') : 'integrações verificadas sem falha',
        })
      );
    }

    const counts = { opened: 0, reopened: 0, updated: 0, closed: 0 } as Record<string, number>;
    for (const c of conditions) {
      const outcome = await asPlatform(() => monitoringService.applyAlert(c, now));
      if (outcome !== 'noop') counts[outcome]++;
    }
    return { skipped: null, samples: written, capped, alerts: counts, backup: backup.status, host: { cpu, mem, disk } };
  } catch (error) {
    logger.error('Coleta da Central de Monitoramento falhou (ignorada)', { error: error instanceof Error ? error.message : String(error) });
    return { skipped: 'error' as const };
  }
}
