import { prisma, runInTransaction } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import { AppError, ConflictError } from '@ln-system/shared';
import type { Threshold } from './health-status';

/**
 * Catálogo das métricas com limite configurável. `defaults` são os padrões do produto (os mesmos de antes da
 * configuração); `bounds` é a faixa permitida: o teto (`max`) impede subir um limite só para esconder um problema
 * (ex.: disco crítico acima de 98% ou latência crítica acima de 10 s).
 */
export const MONITORING_METRICS = {
  apiP95Ms: { label: 'Latência da API (p95)', unit: 'ms', defaults: { attention: 800, critical: 2000 }, bounds: { min: 50, max: 10_000 } },
  api5xxPct: { label: 'Erros 5xx da API', unit: '%', defaults: { attention: 1, critical: 5 }, bounds: { min: 0.1, max: 50 } },
  cpuPct: { label: 'CPU dos equipamentos', unit: '%', defaults: { attention: 80, critical: 95 }, bounds: { min: 30, max: 99 } },
  memPct: { label: 'RAM dos equipamentos', unit: '%', defaults: { attention: 85, critical: 95 }, bounds: { min: 30, max: 99 } },
  diskPct: { label: 'Disco dos equipamentos', unit: '%', defaults: { attention: 85, critical: 95 }, bounds: { min: 30, max: 98 } },
  rttMs: { label: 'Latência da rede (equipamento → API)', unit: 'ms', defaults: { attention: 300, critical: 1000 }, bounds: { min: 20, max: 5_000 } },
  lossPct: { label: 'Perda de pacotes', unit: '%', defaults: { attention: 2, critical: 10 }, bounds: { min: 0.5, max: 50 } },
  // % de equipamentos offline: ATENÇÃO a partir do limite; CRÍTICO quando MAIS que o limite crítico (padrão: mais da metade)
  devicesOfflinePct: { label: 'Equipamentos offline', unit: '%', defaults: { attention: 1, critical: 50 }, bounds: { min: 1, max: 99 } },
  dbLatencyMs: { label: 'Latência do banco (PostgreSQL)', unit: 'ms', defaults: { attention: 200, critical: 1000 }, bounds: { min: 10, max: 5_000 } },
  redisLatencyMs: { label: 'Latência do cache (Redis)', unit: 'ms', defaults: { attention: 100, critical: 500 }, bounds: { min: 5, max: 2_000 } },
  queueWaiting: { label: 'Jobs aguardando na fila', unit: 'jobs', defaults: { attention: 100, critical: 1000 }, bounds: { min: 1, max: 100_000 } },
  queueFailedLastHour: { label: 'Jobs com falha na última hora', unit: 'jobs', defaults: { attention: 1, critical: 20 }, bounds: { min: 1, max: 1_000 } },
  jobsOverdue: { label: 'Jobs agendados atrasados', unit: 'jobs', defaults: { attention: 1, critical: 5 }, bounds: { min: 1, max: 100 } },
} as const satisfies Record<string, { label: string; unit: string; defaults: Threshold; bounds: { min: number; max: number } }>;

export type MonitoringMetric = keyof typeof MONITORING_METRICS;
export type ThresholdSource = 'DEFAULT' | 'GLOBAL' | 'COMPANY' | 'BRANCH';
export type EffectiveThresholds = Record<MonitoringMetric, Threshold & { source: ThresholdSource }>;

const METRIC_KEYS = Object.keys(MONITORING_METRICS) as MonitoringMetric[];
export const isMonitoringMetric = (m: unknown): m is MonitoringMetric => typeof m === 'string' && m in MONITORING_METRICS;

type Row = { companyId: string | null; branchId: string | null; metric: string; attention: number; critical: number };

function resolve(rows: Row[], companyId: string | null, branchId: string | null): EffectiveThresholds {
  const out = {} as EffectiveThresholds;
  for (const metric of METRIC_KEYS) {
    const pick = (c: string | null, b: string | null) => rows.find((r) => r.metric === metric && r.companyId === c && r.branchId === b);
    const branchRow = companyId && branchId ? pick(companyId, branchId) : undefined;
    const companyRow = companyId ? pick(companyId, null) : undefined;
    const globalRow = pick(null, null);
    const row = branchRow ?? companyRow ?? globalRow;
    out[metric] = row
      ? { attention: row.attention, critical: row.critical, source: branchRow ? 'BRANCH' : companyRow ? 'COMPANY' : 'GLOBAL' }
      : { ...MONITORING_METRICS[metric].defaults, source: 'DEFAULT' };
  }
  return out;
}

export class MonitoringThresholdsService {
  /** Resolvedor para uma empresa inteira (uma consulta), usado pela visão consolidada e pelo job de avaliação. */
  async forCompany(companyId: string | null): Promise<(branchId: string | null) => EffectiveThresholds> {
    const rows = await prisma.monitoringThreshold.findMany({
      where: { OR: [{ companyId: null, branchId: null }, ...(companyId ? [{ companyId }] : [])] },
      select: { companyId: true, branchId: true, metric: true, attention: true, critical: true },
    });
    return (branchId) => resolve(rows, companyId, branchId);
  }

  async effective(companyId: string | null, branchId: string | null = null): Promise<EffectiveThresholds> {
    return (await this.forCompany(companyId))(branchId);
  }

  /** Catálogo + valores efetivos para a tela de configuração. */
  async describe(companyId: string | null, branchId: string | null = null) {
    const effective = await this.effective(companyId, branchId);
    return METRIC_KEYS.map((metric) => ({ metric, ...MONITORING_METRICS[metric], ...effective[metric] }));
  }

  private validate(metric: string, attention: unknown, critical: unknown): { metric: MonitoringMetric; attention: number; critical: number } {
    if (!isMonitoringMetric(metric)) throw new AppError('Métrica desconhecida', 400, 'UNKNOWN_METRIC');
    const a = Number(attention);
    const c = Number(critical);
    const { bounds, label, unit } = MONITORING_METRICS[metric];
    if (!Number.isFinite(a) || !Number.isFinite(c)) throw new AppError('Informe os limites de atenção e crítico', 400, 'INVALID_THRESHOLD');
    if (a >= c) throw new AppError('O limite de atenção deve ser menor que o crítico', 400, 'INVALID_THRESHOLD');
    if (a < bounds.min) throw new AppError(`${label}: o limite de atenção não pode ser menor que ${bounds.min} ${unit}`, 400, 'THRESHOLD_OUT_OF_RANGE');
    if (c > bounds.max) {
      throw new AppError(`${label}: o limite crítico não pode passar de ${bounds.max} ${unit} (acima disso o problema ficaria escondido)`, 400, 'THRESHOLD_OUT_OF_RANGE');
    }
    return { metric, attention: a, critical: c };
  }

  private async assertScope(companyId: string | null, branchId: string | null) {
    if (branchId && !companyId) throw new AppError('Filial exige a empresa', 400, 'INVALID_SCOPE');
    if (companyId) {
      const company = await prisma.company.findFirst({ where: { id: companyId }, select: { id: true } });
      if (!company) throw new AppError('Empresa não encontrada', 404, 'COMPANY_NOT_FOUND');
    }
    if (branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId: companyId! }, select: { id: true } });
      if (!branch) throw new AppError('Filial não encontrada nesta empresa', 404, 'BRANCH_NOT_FOUND');
    }
  }

  /** Grava (ou troca) o limite do escopo, com histórico. Exige motivo. Chamador: SUPER_ADMIN (rota + RLS). */
  async set(input: { companyId?: string | null; branchId?: string | null; metric: string; attention: unknown; critical: unknown; reason?: string }, userId: string) {
    const { metric, attention, critical } = this.validate(input.metric, input.attention, input.critical);
    const companyId = input.companyId || null;
    const branchId = input.branchId || null;
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 5) throw new AppError('Informe o motivo da alteração', 400, 'REASON_REQUIRED');
    await this.assertScope(companyId, branchId);
    try {
      return await runInTransaction(async (tx) => {
        const current = await tx.monitoringThreshold.findFirst({ where: { companyId, branchId, metric } });
        const saved = current
          ? await tx.monitoringThreshold.update({ where: { id: current.id }, data: { attention, critical, updatedBy: userId } })
          : await tx.monitoringThreshold.create({ data: { companyId, branchId, metric, attention, critical, updatedBy: userId } });
        await tx.monitoringThresholdChange.create({
          data: {
            companyId, branchId, metric, reason, changedBy: userId,
            oldAttention: current?.attention ?? null, oldCritical: current?.critical ?? null, newAttention: attention, newCritical: critical,
          },
        });
        return saved;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('Outro ajuste deste limite foi salvo ao mesmo tempo. Atualize e tente de novo.', 'THRESHOLD_CONFLICT');
      }
      throw error;
    }
  }

  /** Remove o ajuste do escopo (volta a valer o do escopo acima/padrão), com histórico. */
  async reset(input: { companyId?: string | null; branchId?: string | null; metric: string; reason?: string }, userId: string) {
    if (!isMonitoringMetric(input.metric)) throw new AppError('Métrica desconhecida', 400, 'UNKNOWN_METRIC');
    const companyId = input.companyId || null;
    const branchId = input.branchId || null;
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 5) throw new AppError('Informe o motivo da alteração', 400, 'REASON_REQUIRED');
    return runInTransaction(async (tx) => {
      const current = await tx.monitoringThreshold.findFirst({ where: { companyId, branchId, metric: input.metric } });
      if (!current) throw new AppError('Não há ajuste neste escopo para esta métrica', 404, 'THRESHOLD_NOT_FOUND');
      await tx.monitoringThreshold.delete({ where: { id: current.id } });
      await tx.monitoringThresholdChange.create({
        data: { companyId, branchId, metric: input.metric, reason, changedBy: userId, oldAttention: current.attention, oldCritical: current.critical },
      });
      return { removed: true };
    });
  }

  async history(companyId: string | null, limit = 100) {
    return prisma.monitoringThresholdChange.findMany({
      where: companyId ? { OR: [{ companyId }, { companyId: null }] } : {},
      orderBy: { changedAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }
}

export default new MonitoringThresholdsService();
