/**
 * AJUSTES E LIMITES DE CUSTO da Central de Monitoramento. O AMBIENTE é o teto: o Super Admin só consegue RESTRINGIR em tempo de execução (desligar notificações,
 * Sentry ou a coleta; baixar limites), nunca subir um limite acima do configurado no servidor. Nada aqui contrata plano, autoriza excedente ou liga serviço pago.
 * Os padrões são conservadores e ficam abaixo dos limites públicos das modalidades gratuitas (que mudam: confira a página do provedor antes de ligar cada serviço).
 */
import type { Prisma } from '@prisma/client';
import { prisma, runInTransaction, runWithRLSContext } from '@ln-system/database';
import { AppError } from '@ln-system/shared';

const PLATFORM_CONTEXT = { companyId: null, userType: 'SUPER_ADMIN', branchId: null } as const;

/** Executa `fn` no contexto de PLATAFORMA (Super Admin sem empresa): jobs e coletores rodam fora de qualquer requisição. O `await` fica DENTRO do escopo. */
export function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRLSContext(PLATFORM_CONTEXT as any, async () => await fn()) as Promise<T>;
}

/**
 * SQL cru COM o contexto de RLS do chamador. `prisma.$queryRaw` fora de `runInTransaction` roda SEM contexto (não passa pelo `$allOperations`) e, sob FORCE RLS, devolve zero
 * linhas em silêncio — o número parece "vazio" e não "negado". Todo SQL cru da Central passa por aqui.
 */
export function rawQuery<T>(sql: Prisma.Sql): Promise<T> {
  return runInTransaction((tx) => tx.$queryRaw<T>(sql));
}

export interface MonitoringLimits {
  emailMaxPerHour: number;
  emailMaxPerDay: number;
  emailMaxPerMonth: number;
  emailDedupeMinutes: number;
  sentryMaxPerHour: number;
  sentryMaxPerDay: number;
  sentrySampleRate: number;
  sentryDedupeMinutes: number;
  /** Intervalo entre amostras de saúde (minutos). */
  sampleMinutes: number;
  samplesMaxPerDay: number;
}

export interface MonitoringToggles {
  emailNotifications: boolean;
  sentry: boolean;
  sampling: boolean;
}

export interface MonitoringRetention {
  sampleDays: number;
  deliveryDays: number;
  alertDays: number;
}

export interface MonitoringOverrides {
  toggles?: Partial<MonitoringToggles>;
  limits?: Partial<MonitoringLimits>;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Limites vindos do AMBIENTE (o teto). */
export function envLimits(env: NodeJS.ProcessEnv = process.env): MonitoringLimits {
  return {
    emailMaxPerHour: num(env, 'ALERT_EMAIL_MAX_PER_HOUR', 6, 0, 1000),
    emailMaxPerDay: num(env, 'ALERT_EMAIL_MAX_PER_DAY', 30, 0, 10_000),
    emailMaxPerMonth: num(env, 'ALERT_EMAIL_MAX_PER_MONTH', 600, 0, 1_000_000),
    emailDedupeMinutes: num(env, 'ALERT_EMAIL_DEDUPE_MINUTES', 60, 1, 1440),
    sentryMaxPerHour: num(env, 'SENTRY_MAX_EVENTS_PER_HOUR', 30, 0, 100_000),
    sentryMaxPerDay: num(env, 'SENTRY_MAX_EVENTS_PER_DAY', 200, 0, 1_000_000),
    sentrySampleRate: num(env, 'SENTRY_SAMPLE_RATE', 0.25, 0, 1),
    sentryDedupeMinutes: num(env, 'SENTRY_DEDUPE_MINUTES', 5, 1, 1440),
    sampleMinutes: num(env, 'MONITORING_SAMPLE_MINUTES', 5, 1, 60),
    samplesMaxPerDay: num(env, 'MONITORING_SAMPLES_MAX_PER_DAY', 4000, 0, 1_000_000),
  };
}

export function envRetention(env: NodeJS.ProcessEnv = process.env): MonitoringRetention {
  return {
    sampleDays: num(env, 'MONITORING_SAMPLE_RETENTION_DAYS', 30, 1, 3650),
    deliveryDays: num(env, 'MONITORING_DELIVERY_RETENTION_DAYS', 60, 1, 3650),
    alertDays: num(env, 'MONITORING_ALERT_RETENTION_DAYS', 365, 30, 3650),
  };
}

const LIMIT_KEYS = Object.keys(envLimits({})) as Array<keyof MonitoringLimits>;
const TOGGLE_KEYS: Array<keyof MonitoringToggles> = ['emailNotifications', 'sentry', 'sampling'];

/**
 * Efetivo = ambiente restringido pelo ajuste. Chaves de TETO (máximos e taxa de amostragem) usam o MENOR valor; o intervalo de coleta usa o MAIOR (coletar menos
 * vezes); chave liga/desliga só pode DESLIGAR. Assim um ajuste nunca aumenta consumo nem gasto.
 */
export function resolveEffective(env: NodeJS.ProcessEnv, overrides: MonitoringOverrides | null) {
  const base = envLimits(env);
  const limits = { ...base };
  const overridden: string[] = [];
  for (const key of LIMIT_KEYS) {
    const o = overrides?.limits?.[key];
    if (typeof o !== 'number' || !Number.isFinite(o)) continue;
    const next = key === 'sampleMinutes' ? Math.max(base[key], o) : Math.min(base[key], o);
    if (next !== base[key]) {
      limits[key] = next;
      overridden.push(key);
    }
  }
  const toggles: MonitoringToggles = { emailNotifications: true, sentry: true, sampling: true };
  for (const key of TOGGLE_KEYS) {
    if (overrides?.toggles?.[key] === false) {
      toggles[key] = false;
      overridden.push(key);
    }
  }
  return { env: base, limits, toggles, overridden };
}

/** Valida o pedido de ajuste: só chaves conhecidas, números finitos não negativos, booleanos. `null` remove o ajuste daquela chave. */
export function validateOverridesPatch(patch: unknown): { toggles: Record<string, boolean | null>; limits: Record<string, number | null> } {
  if (!patch || typeof patch !== 'object') throw new AppError('Informe os ajustes a aplicar.', 400, 'INVALID_SETTINGS');
  const p = patch as { toggles?: Record<string, unknown>; limits?: Record<string, unknown> };
  const out = { toggles: {} as Record<string, boolean | null>, limits: {} as Record<string, number | null> };
  for (const [k, v] of Object.entries(p.toggles ?? {})) {
    if (!(TOGGLE_KEYS as string[]).includes(k)) throw new AppError(`Ajuste desconhecido: ${k}`, 400, 'INVALID_SETTINGS');
    if (v !== null && typeof v !== 'boolean') throw new AppError(`O ajuste ${k} deve ser verdadeiro, falso ou nulo.`, 400, 'INVALID_SETTINGS');
    out.toggles[k] = v as boolean | null;
  }
  for (const [k, v] of Object.entries(p.limits ?? {})) {
    if (!(LIMIT_KEYS as string[]).includes(k)) throw new AppError(`Limite desconhecido: ${k}`, 400, 'INVALID_SETTINGS');
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new AppError(`O limite ${k} deve ser um número maior ou igual a zero.`, 400, 'INVALID_SETTINGS');
    out.limits[k] = v as number | null;
  }
  if (Object.keys(out.toggles).length + Object.keys(out.limits).length === 0) throw new AppError('Nenhum ajuste informado.', 400, 'INVALID_SETTINGS');
  return out;
}

const SETTINGS_KEY = 'config';
let cache: { at: number; value: MonitoringOverrides | null } | null = null;
const CACHE_MS = 15_000;

export async function readOverrides(force = false): Promise<MonitoringOverrides | null> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: MonitoringOverrides | null = null;
  try {
    const row = await asPlatform(() => prisma.monitoringSetting.findUnique({ where: { key: SETTINGS_KEY } }));
    value = (row?.value as MonitoringOverrides | undefined) ?? null;
  } catch {
    value = cache?.value ?? null; // falha de leitura não derruba a coleta: vale o último ajuste conhecido
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Ajustes efetivos agora (ambiente + restrições do Super Admin). Nunca lança. */
export async function getEffective(env: NodeJS.ProcessEnv = process.env) {
  return resolveEffective(env, await readOverrides());
}

export async function updateOverrides(patch: unknown, userId: string) {
  const clean = validateOverridesPatch(patch);
  const current = (await readOverrides(true)) ?? {};
  const next: MonitoringOverrides = { toggles: { ...(current.toggles ?? {}) }, limits: { ...(current.limits ?? {}) } };
  for (const [k, v] of Object.entries(clean.toggles)) {
    if (v === null) delete (next.toggles as Record<string, unknown>)[k];
    else (next.toggles as Record<string, unknown>)[k] = v;
  }
  for (const [k, v] of Object.entries(clean.limits)) {
    if (v === null) delete (next.limits as Record<string, unknown>)[k];
    else (next.limits as Record<string, unknown>)[k] = v;
  }
  await asPlatform(() =>
    prisma.monitoringSetting.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value: next as object, updatedBy: userId },
      update: { value: next as object, updatedBy: userId },
    })
  );
  cache = { at: Date.now(), value: next };
  return resolveEffective(process.env, next);
}

/** Só para testes. */
export function __resetSettingsCache() {
  cache = null;
}
