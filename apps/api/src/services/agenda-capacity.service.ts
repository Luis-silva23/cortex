import { prisma, runInTransaction, PrismaTransactionClient } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { withCompanyWideRead } from '../utils/company-wide-read';
import { policyService, POLICY_CATALOG, type EffectivePolicies } from './policy.service';
import { businessHoursService, localParts, windowOpenIn, type OpenCheck } from './business-hours.service';

/**
 * Capacidade configurável da agenda (docs/CORTEX/policies/AGENDA.md). A empresa/filial define o que consegue atender;
 * o CÓRTEX só fornece o mecanismo. Todas as políticas são por filial (branchOverridable) e vazias = sem limite:
 *
 * - duração do atendimento: a do agendamento → `agenda.defaultDurationMinutes` → um horário (`agenda.slotMinutes`).
 *   Janela = [início, início + duração);
 * - `agenda.maxPerSlot`   → quantos agendamentos COMEÇAM no mesmo horário (inalterado)        → 409 SLOT_FULL;
 * - `agenda.boxCount`     → atendimentos SIMULTÂNEOS na filial, pela duração de cada um          → 409 NO_BOX_AVAILABLE;
 * - `agenda.maxPerDay`    → agendamentos ativos da filial no dia (fuso `company.timezone`)        → 409 DAY_FULL;
 * - `agenda.maxPerMonth`  → idem no mês                                                            → 409 MONTH_FULL;
 * - mecânico (opcional): não pode ter outro atendimento ativo sobreposto (em qualquer filial)      → 409 MECHANIC_CONFLICT;
 * - indisponibilidade (agenda_unavailabilities): da filial inteira → 409 AGENDA_UNAVAILABLE; do mecânico → 409
 *   MECHANIC_UNAVAILABLE.
 *
 * Tudo é contado e gravado na MESMA transação, serializada por uma trava por FILIAL (4210) e, com mecânico, outra por
 * mecânico (4211) — ver assertAgendaCapacity.
 */

export const ACTIVE_STATUSES: Array<'PROPOSED' | 'CONFIRMED'> = ['PROPOSED', 'CONFIRMED'];
const MINUTE = 60_000;
/** Maior duração aceita (CHECK do banco): um agendamento que começou até 24 h antes ainda pode ocupar a janela. */
const MAX_DURATION_MINUTES = 1440;

type Limits = { maxPerSlot: number | null; maxPerDay: number | null; maxPerMonth: number | null; boxCount: number | null };
type Interval = { start: number; end: number };
type Block = { startsAt: Date; endsAt: Date; reason: string };

// ---------------------------------------------------------------------------------------------------------------
// Tempo no fuso da empresa
// ---------------------------------------------------------------------------------------------------------------

/**
 * Horário (slot) de agenda que contém `at`: janelas de `slotMinutes` alinhadas à meia-noite LOCAL (fuso da política
 * `company.timezone`). Ex.: slot de 60 min, 10:37 → [10:00, 11:00). O fuso tem deslocamento em minutos inteiros, então
 * basta recuar os minutos/segundos locais.
 */
export function slotOf(at: Date, timeZone: string, slotMinutes: number) {
  const local = localParts(at, timeZone);
  const offsetInSlot = local.minutes % slotMinutes;
  const start = new Date(at.getTime() - offsetInSlot * 60_000 - at.getUTCSeconds() * 1000 - at.getUTCMilliseconds());
  return { start, end: new Date(start.getTime() + slotMinutes * 60_000) };
}

/** Dia local [00:00, 00:00 do dia seguinte) que contém `at`. */
export function localDayRange(at: Date, timeZone: string) {
  const start = slotOf(at, timeZone, 1440).start;
  // +36 h cai no meio do dia seguinte mesmo com virada de horário de verão.
  const end = slotOf(new Date(start.getTime() + 36 * 3_600_000), timeZone, 1440).start;
  return { start, end };
}

/** Mês local [dia 1 00:00, dia 1 do mês seguinte 00:00) que contém `at`. */
export function localMonthRange(at: Date, timeZone: string) {
  const firstOfMonth = (d: Date) => {
    const day = Number(localParts(d, timeZone).date.slice(8, 10));
    const dayStart = localDayRange(d, timeZone).start;
    return localDayRange(new Date(dayStart.getTime() - (day - 1) * 86_400_000 + 12 * 3_600_000), timeZone).start;
  };
  const start = firstOfMonth(at);
  // dia 1 + 32 dias cai entre os dias 1 e 4 do mês seguinte
  const end = firstOfMonth(new Date(start.getTime() + 32 * 86_400_000 + 12 * 3_600_000));
  return { start, end };
}

/** Início do dia local AAAA-MM-DD (meio-dia UTC está no mesmo dia local em todos os fusos do Brasil). */
export function localDateStart(date: string, timeZone: string) {
  return localDayRange(new Date(`${date}T12:00:00.000Z`), timeZone).start;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
export function timeLabel(d: Date, tz: string) {
  return hm(localParts(d, tz).minutes);
}
export function dateLabel(d: Date, tz: string) {
  const [y, mo, da] = localParts(d, tz).date.split('-');
  return `${da}/${mo}/${y}`;
}
function rangeLabel(start: Date, end: Date, tz: string) {
  const sameDay = localParts(start, tz).date === localParts(new Date(end.getTime() - 1), tz).date;
  return sameDay
    ? `em ${dateLabel(start, tz)} das ${timeLabel(start, tz)} às ${timeLabel(end, tz)}`
    : `de ${dateLabel(start, tz)} ${timeLabel(start, tz)} a ${dateLabel(end, tz)} ${timeLabel(end, tz)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Regras puras (usadas na gravação e na tela de disponibilidade)
// ---------------------------------------------------------------------------------------------------------------

export function effectiveDuration(
  requested: number | null | undefined,
  policies: Pick<EffectivePolicies, 'agenda.defaultDurationMinutes' | 'agenda.slotMinutes'>
): number {
  return requested ?? policies['agenda.defaultDurationMinutes'] ?? policies['agenda.slotMinutes'];
}

function limitsOf(p: EffectivePolicies): Limits {
  return {
    maxPerSlot: p['agenda.maxPerSlot'] ?? null,
    maxPerDay: p['agenda.maxPerDay'] ?? null,
    maxPerMonth: p['agenda.maxPerMonth'] ?? null,
    boxCount: p['agenda.boxCount'] ?? null,
  };
}

/** Maior número de intervalos ativos ao mesmo tempo dentro de [from, to) (quem termina às 10:00 libera o box das 10:00). */
export function peakConcurrency(busy: Interval[], from: number, to: number): number {
  const events: Array<[number, number]> = [];
  for (const b of busy) {
    const s = Math.max(b.start, from);
    const e = Math.min(b.end, to);
    if (s < e) events.push([s, 1], [e, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

export interface CapacityViolation {
  code: 'AGENDA_UNAVAILABLE' | 'MECHANIC_UNAVAILABLE' | 'MECHANIC_CONFLICT' | 'SLOT_FULL' | 'NO_BOX_AVAILABLE' | 'DAY_FULL' | 'MONTH_FULL' | 'OUTSIDE_BUSINESS_HOURS';
  message: string;
}

export interface WindowFacts {
  tz: string;
  start: Date;
  end: Date;
  limits: Limits;
  slot: { start: Date; end: Date };
  slotCount: number;
  dayCount: number;
  monthCount: number;
  branchBusy: Interval[];
  mechanicBusy: Interval[];
  branchBlocks: Block[];
  mechanicBlocks: Block[];
}

const overlaps = (a: { start: number; end: number }, s: Date, e: Date) => a.start < e.getTime() && a.end > s.getTime();

/**
 * Primeira regra violada pela janela, na ordem do mais específico para o mais geral: indisponibilidade → mecânico →
 * horário → box → dia → mês. `null` = cabe.
 */
export function firstViolation(f: WindowFacts): CapacityViolation | null {
  const { tz, start, end, limits } = f;
  const branchBlock = f.branchBlocks.find((b) => overlaps({ start: b.startsAt.getTime(), end: b.endsAt.getTime() }, start, end));
  if (branchBlock) {
    return {
      code: 'AGENDA_UNAVAILABLE',
      message: `A agenda da filial está indisponível ${rangeLabel(branchBlock.startsAt, branchBlock.endsAt, tz)} (${branchBlock.reason}). Escolha outro horário.`,
    };
  }
  const mechanicBlock = f.mechanicBlocks.find((b) => overlaps({ start: b.startsAt.getTime(), end: b.endsAt.getTime() }, start, end));
  if (mechanicBlock) {
    return {
      code: 'MECHANIC_UNAVAILABLE',
      message: `O mecânico escolhido está indisponível ${rangeLabel(mechanicBlock.startsAt, mechanicBlock.endsAt, tz)} (${mechanicBlock.reason}). Escolha outro horário ou outro mecânico.`,
    };
  }
  const busy = f.mechanicBusy.find((b) => overlaps(b, start, end));
  if (busy) {
    return {
      code: 'MECHANIC_CONFLICT',
      message: `O mecânico escolhido já tem um atendimento ${rangeLabel(new Date(busy.start), new Date(busy.end), tz)}. Escolha outro horário ou outro mecânico.`,
    };
  }
  if (limits.maxPerSlot !== null && f.slotCount >= limits.maxPerSlot) {
    return {
      code: 'SLOT_FULL',
      message: `Horário lotado: já há ${f.slotCount} agendamento(s) entre ${timeLabel(f.slot.start, tz)} e ${timeLabel(f.slot.end, tz)} (limite ${limits.maxPerSlot} por horário). Escolha outro horário.`,
    };
  }
  if (limits.boxCount !== null && peakConcurrency(f.branchBusy, start.getTime(), end.getTime()) >= limits.boxCount) {
    return {
      code: 'NO_BOX_AVAILABLE',
      message: `Não há box livre nesse horário: ${limits.boxCount === 1 ? 'o único box está ocupado' : `os ${limits.boxCount} boxes estão ocupados`} em algum momento entre ${timeLabel(start, tz)} e ${timeLabel(end, tz)}. Escolha outro horário ou fale com a gerência.`,
    };
  }
  if (limits.maxPerDay !== null && f.dayCount >= limits.maxPerDay) {
    return {
      code: 'DAY_FULL',
      message: `A agenda de ${dateLabel(start, tz)} está lotada: já há ${f.dayCount} agendamento(s) (limite ${limits.maxPerDay} por dia). Escolha outro dia ou fale com a gerência.`,
    };
  }
  if (limits.maxPerMonth !== null && f.monthCount >= limits.maxPerMonth) {
    return {
      code: 'MONTH_FULL',
      message: `A agenda de ${dateLabel(start, tz).slice(3)} está lotada: já há ${f.monthCount} agendamento(s) no mês (limite ${limits.maxPerMonth}). Escolha outro mês ou fale com a gerência.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Mecânico
// ---------------------------------------------------------------------------------------------------------------

/** Mecânico previsto: usuário MECHANIC ativo da MESMA empresa e com acesso à filial (da filial ou da empresa toda). */
export async function assertMechanicForBranch(companyId: string, branchId: string | null | undefined, mechanicId: string) {
  const mechanic = await prisma.user.findFirst({
    where: { id: mechanicId, companyId },
    select: { id: true, name: true, userType: true, isActive: true, branchId: true },
  });
  if (!mechanic || mechanic.userType !== 'MECHANIC') {
    throw new AppError('Mecânico não encontrado nesta empresa. Escolha um mecânico cadastrado.', 400, 'INVALID_MECHANIC');
  }
  if (!mechanic.isActive) throw new AppError('Este mecânico está inativo. Escolha outro mecânico.', 400, 'INVALID_MECHANIC');
  if (branchId && mechanic.branchId && mechanic.branchId !== branchId) {
    throw new AppError('Este mecânico é de outra filial. Escolha um mecânico desta filial.', 400, 'INVALID_MECHANIC');
  }
  return mechanic;
}

/** Duração padrão por filial (para agendamentos sem duração própria de OUTRAS filiais do mesmo mecânico). */
async function durationPoliciesByBranch(tx: PrismaTransactionClient, companyId: string, branchIds: string[]) {
  const keys = ['agenda.defaultDurationMinutes', 'agenda.slotMinutes'] as const;
  const rows = await tx.policySetting.findMany({
    where: { companyId, key: { in: [...keys] }, OR: [{ branchId: null }, { branchId: { in: branchIds } }] },
    select: { key: true, branchId: true, value: true },
  });
  const pick = (key: (typeof keys)[number], branchId: string | null) => {
    const row = rows.find((r) => r.key === key && r.branchId === branchId) ?? rows.find((r) => r.key === key && r.branchId === null);
    const parsed = row ? (POLICY_CATALOG[key].schema as any).safeParse(row.value) : null;
    return parsed?.success ? parsed.data : POLICY_CATALOG[key].default;
  };
  return (branchId: string | null) => ({ 'agenda.defaultDurationMinutes': pick(keys[0], branchId), 'agenda.slotMinutes': pick(keys[1], branchId) });
}

async function loadMechanicAgenda(
  tx: PrismaTransactionClient,
  input: { companyId: string; branchId: string | null; mechanicId: string; from: Date; to: Date; excludeId?: string; policies: EffectivePolicies }
): Promise<{ busy: Interval[]; blocks: Block[] }> {
  // Mecânico da empresa toda: o conflito em outra filial precisa ser visto (só os intervalos dele; utils/company-wide-read.ts).
  return withCompanyWideRead(tx, input.companyId, async () => {
    const rows = await tx.appointment.findMany({
      where: {
        companyId: input.companyId,
        mechanicId: input.mechanicId,
        status: { in: ACTIVE_STATUSES },
        scheduledAt: { lt: input.to, gt: new Date(input.from.getTime() - MAX_DURATION_MINUTES * MINUTE) },
        ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      },
      select: { scheduledAt: true, durationMinutes: true, branchId: true },
    });
    const otherBranches = [...new Set(rows.map((r) => r.branchId).filter((b): b is string => !!b && b !== input.branchId))];
    const otherPolicies = otherBranches.length ? await durationPoliciesByBranch(tx, input.companyId, otherBranches) : null;
    const busy = rows.map((r) => {
      const p = r.branchId === input.branchId || !otherPolicies ? input.policies : otherPolicies(r.branchId);
      const start = r.scheduledAt.getTime();
      return { start, end: start + effectiveDuration(r.durationMinutes, p) * MINUTE };
    });
    const blocks = await tx.agendaUnavailability.findMany({
      where: { companyId: input.companyId, mechanicId: input.mechanicId, startsAt: { lt: input.to }, endsAt: { gt: input.from } },
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true, endsAt: true, reason: true },
    });
    return { busy, blocks };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Gravação: checagem sob trava (propor / remarcar)
// ---------------------------------------------------------------------------------------------------------------

export interface AgendaWindow {
  start: Date;
  end: Date;
  durationMinutes: number;
}

export function agendaWindow(start: Date, requestedDuration: number | null | undefined, policies: EffectivePolicies): AgendaWindow {
  const durationMinutes = effectiveDuration(requestedDuration, policies);
  return { start, end: new Date(start.getTime() + durationMinutes * MINUTE), durationMinutes };
}

/**
 * Horário de funcionamento (`agenda.respectBusinessHours` + horário cadastrado): a janela INTEIRA precisa caber num
 * período de funcionamento — início dentro do expediente e fim até o fechamento, sem atravessar o intervalo nem o dia.
 * Sem horário cadastrado nada é bloqueado.
 */
export async function assertWindowInBusinessHours(companyId: string, branchId: string | null | undefined, window: AgendaWindow, policies: EffectivePolicies) {
  if (!policies['agenda.respectBusinessHours']) return;
  const open = await businessHoursService.isWindowOpen(companyId, branchId, window.start, window.end);
  if (open.configured && !open.open) {
    throw new AppError(`Horário fora do funcionamento: ${open.reason}`, 409, 'OUTSIDE_BUSINESS_HOURS');
  }
}

/**
 * Todas as regras de capacidade, contadas na MESMA transação em que o agendamento é gravado.
 *
 * Trava: `pg_advisory_xact_lock(4210, filial)`. A trava antiga era por filial+horário, suficiente só para "quantos
 * começam neste horário". Com duração (uma janela ocupa vários horários), boxes (simultaneidade), dia e mês, dois
 * pedidos em horários DIFERENTES disputam a mesma vaga — só uma trava por filial serializa todos. Custo: propostas e
 * remarcações da mesma filial passam uma de cada vez (poucos milissegundos, volume de oficina). Com mecânico, também
 * `pg_advisory_xact_lock(4211, empresa|mecânico)`: o mesmo mecânico em duas filiais (travas de filial diferentes) não é
 * reservado duas vezes. Ordem fixa (filial → mecânico, um mecânico por pedido) — sem ciclo de espera.
 */
export async function assertAgendaCapacity(
  tx: PrismaTransactionClient,
  input: {
    companyId: string;
    branchId: string | null | undefined;
    window: AgendaWindow;
    mechanicId?: string | null;
    excludeId?: string;
    policies: EffectivePolicies;
  }
) {
  const { companyId, window, policies } = input;
  const branchId = input.branchId ?? null;
  const tz = policies['company.timezone'];
  const limits = limitsOf(policies);
  const exclude = input.excludeId ? { id: { not: input.excludeId } } : {};

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4210, hashtext(${branchId ?? `company:${companyId}`}))`;
  if (input.mechanicId) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(4211, hashtext(${`${companyId}|${input.mechanicId}`}))`;
  }

  const branchBlocks = branchId
    ? await tx.agendaUnavailability.findMany({
        where: { companyId, branchId, mechanicId: null, startsAt: { lt: window.end }, endsAt: { gt: window.start } },
        orderBy: { startsAt: 'asc' },
        select: { startsAt: true, endsAt: true, reason: true },
      })
    : [];
  const mechanic = input.mechanicId
    ? await loadMechanicAgenda(tx, { companyId, branchId, mechanicId: input.mechanicId, from: window.start, to: window.end, excludeId: input.excludeId, policies })
    : { busy: [], blocks: [] };

  const base = { companyId, branchId, status: { in: ACTIVE_STATUSES } };
  const slot = slotOf(window.start, tz, policies['agenda.slotMinutes']);
  const slotCount =
    limits.maxPerSlot !== null ? await tx.appointment.count({ where: { ...base, scheduledAt: { gte: slot.start, lt: slot.end }, ...exclude } }) : 0;
  const branchBusy: Interval[] =
    limits.boxCount !== null
      ? (
          await tx.appointment.findMany({
            where: { ...base, scheduledAt: { lt: window.end, gt: new Date(window.start.getTime() - MAX_DURATION_MINUTES * MINUTE) }, ...exclude },
            select: { scheduledAt: true, durationMinutes: true },
          })
        ).map((r) => ({ start: r.scheduledAt.getTime(), end: r.scheduledAt.getTime() + effectiveDuration(r.durationMinutes, policies) * MINUTE }))
      : [];
  const day = localDayRange(window.start, tz);
  const dayCount = limits.maxPerDay !== null ? await tx.appointment.count({ where: { ...base, scheduledAt: { gte: day.start, lt: day.end }, ...exclude } }) : 0;
  const month = localMonthRange(window.start, tz);
  const monthCount =
    limits.maxPerMonth !== null ? await tx.appointment.count({ where: { ...base, scheduledAt: { gte: month.start, lt: month.end }, ...exclude } }) : 0;

  const violation = firstViolation({
    tz,
    start: window.start,
    end: window.end,
    limits,
    slot,
    slotCount,
    dayCount,
    monthCount,
    branchBusy,
    mechanicBusy: mechanic.busy,
    branchBlocks,
    mechanicBlocks: mechanic.blocks,
  });
  if (violation) throw new AppError(violation.message, 409, violation.code);
}

// ---------------------------------------------------------------------------------------------------------------
// Disponibilidade (telas): cada horário do dia, livre ou não e por quê
// ---------------------------------------------------------------------------------------------------------------

export async function agendaAvailability(input: {
  companyId: string;
  branchId: string | null;
  date: string;
  mechanicId?: string | null;
  durationMinutes?: number | null;
}) {
  const { companyId, branchId } = input;
  const policies = await policyService.effective(companyId, branchId);
  const tz = policies['company.timezone'];
  const slotMinutes = policies['agenda.slotMinutes'];
  const durationMinutes = effectiveDuration(input.durationMinutes, policies);
  const limits = limitsOf(policies);
  const day = localDayRange(localDateStart(input.date, tz), tz);
  const horizonEnd = new Date(day.end.getTime() + MAX_DURATION_MINUTES * MINUTE);
  const schedule = policies['agenda.respectBusinessHours'] ? await businessHoursService.getSchedule(companyId, branchId) : null;
  if (input.mechanicId) await assertMechanicForBranch(companyId, branchId, input.mechanicId);

  const data = await runInTransaction(async (tx) => {
    const base = { companyId, branchId, status: { in: ACTIVE_STATUSES } };
    const rows = await tx.appointment.findMany({
      where: { ...base, scheduledAt: { gte: new Date(day.start.getTime() - MAX_DURATION_MINUTES * MINUTE), lt: horizonEnd } },
      select: { scheduledAt: true, durationMinutes: true },
    });
    const branchBlocks = branchId
      ? await tx.agendaUnavailability.findMany({
          where: { companyId, branchId, mechanicId: null, startsAt: { lt: horizonEnd }, endsAt: { gt: day.start } },
          orderBy: { startsAt: 'asc' },
          select: { startsAt: true, endsAt: true, reason: true },
        })
      : [];
    const mechanic = input.mechanicId
      ? await loadMechanicAgenda(tx, { companyId, branchId, mechanicId: input.mechanicId, from: day.start, to: horizonEnd, policies })
      : { busy: [], blocks: [] };
    const month = localMonthRange(day.start, tz);
    const monthCount = limits.maxPerMonth !== null ? await tx.appointment.count({ where: { ...base, scheduledAt: { gte: month.start, lt: month.end } } }) : 0;
    return { rows, branchBlocks, mechanic, monthCount };
  });

  const branchBusy = data.rows.map((r) => ({ start: r.scheduledAt.getTime(), end: r.scheduledAt.getTime() + effectiveDuration(r.durationMinutes, policies) * MINUTE }));
  const dayCount = data.rows.filter((r) => r.scheduledAt >= day.start && r.scheduledAt < day.end).length;
  const slots: Array<{ start: string; end: string; time: string; booked: number; available: boolean; code: CapacityViolation['code'] | null; reason: string | null }> = [];
  for (let t = day.start.getTime(); t < day.end.getTime(); t += slotMinutes * MINUTE) {
    const start = new Date(t);
    const end = new Date(t + durationMinutes * MINUTE);
    const slot = { start, end: new Date(Math.min(t + slotMinutes * MINUTE, day.end.getTime())) };
    const slotCount = data.rows.filter((r) => r.scheduledAt >= slot.start && r.scheduledAt < slot.end).length;
    const hours: OpenCheck | null = schedule ? windowOpenIn(schedule, branchId, start, end) : null;
    const violation: CapacityViolation | null =
      hours && hours.configured && !hours.open
        ? { code: 'OUTSIDE_BUSINESS_HOURS', message: `Horário fora do funcionamento: ${hours.reason}` }
        : firstViolation({
            tz,
            start,
            end,
            limits,
            slot,
            slotCount,
            dayCount,
            monthCount: data.monthCount,
            branchBusy,
            mechanicBusy: data.mechanic.busy,
            branchBlocks: data.branchBlocks,
            mechanicBlocks: data.mechanic.blocks,
          });
    slots.push({
      start: start.toISOString(),
      end: end.toISOString(),
      time: timeLabel(start, tz),
      booked: slotCount,
      available: !violation,
      code: violation?.code ?? null,
      reason: violation?.message ?? null,
    });
  }
  return {
    date: input.date,
    branchId,
    mechanicId: input.mechanicId ?? null,
    timezone: tz,
    slotMinutes,
    durationMinutes,
    limits,
    dayCount,
    monthCount: data.monthCount,
    slots,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Indisponibilidades (gerência)
// ---------------------------------------------------------------------------------------------------------------

export const agendaUnavailabilityService = {
  async list(filters: { companyId: string; branchId?: string | null; mechanicId?: string; from?: Date; to?: Date }) {
    const rows = await prisma.agendaUnavailability.findMany({
      where: {
        companyId: filters.companyId,
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
        ...(filters.mechanicId ? { mechanicId: filters.mechanicId } : {}),
        ...(filters.to ? { startsAt: { lt: filters.to } } : {}),
        ...(filters.from ? { endsAt: { gt: filters.from } } : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: 500,
    });
    const mechanicIds = [...new Set(rows.map((r) => r.mechanicId).filter((m): m is string => !!m))];
    const names = mechanicIds.length
      ? await prisma.user.findMany({ where: { id: { in: mechanicIds }, companyId: filters.companyId }, select: { id: true, name: true } })
      : [];
    return rows.map((r) => ({ ...r, mechanicName: r.mechanicId ? names.find((n) => n.id === r.mechanicId)?.name ?? null : null }));
  },

  /** Cria a indisponibilidade. Agendamentos já marcados na janela NÃO são cancelados: a resposta diz quantos há. */
  async create(input: { companyId: string; branchId: string; mechanicId?: string | null; startsAt: Date; endsAt: Date; reason: string; createdBy: string }) {
    if (!(input.endsAt.getTime() > input.startsAt.getTime())) {
      throw new AppError('O fim da indisponibilidade precisa ser depois do início.', 400, 'INVALID_UNAVAILABILITY');
    }
    const reason = input.reason.trim();
    if (reason.length < 3) throw new AppError('Informe o motivo da indisponibilidade.', 400, 'REASON_REQUIRED');
    if (input.mechanicId) await assertMechanicForBranch(input.companyId, input.branchId, input.mechanicId);
    const created = await prisma.agendaUnavailability.create({
      data: {
        companyId: input.companyId,
        branchId: input.branchId,
        mechanicId: input.mechanicId ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason,
        createdBy: input.createdBy,
      },
    });
    // Informativo para a tela ("há N agendamentos nesse período — remarque-os"): nada é cancelado automaticamente.
    const policies = await policyService.effective(input.companyId, input.branchId);
    const nearby = await prisma.appointment.findMany({
      where: {
        companyId: input.companyId,
        status: { in: ACTIVE_STATUSES },
        scheduledAt: { lt: input.endsAt, gt: new Date(input.startsAt.getTime() - MAX_DURATION_MINUTES * MINUTE) },
        ...(input.mechanicId ? { mechanicId: input.mechanicId } : { branchId: input.branchId }),
      },
      select: { scheduledAt: true, durationMinutes: true },
    });
    const overlappingAppointments = nearby.filter(
      (r) => r.scheduledAt.getTime() + effectiveDuration(r.durationMinutes, policies) * MINUTE > input.startsAt.getTime()
    ).length;
    return { ...created, overlappingAppointments };
  },

  /** Remover é da gerência (a rota restringe) e fica auditado; vale para indisponibilidade passada ou futura. */
  async remove(companyId: string, id: string, userBranchId?: string | null) {
    // Usuário de filial só remove a da própria filial (além do RLS, filtro explícito na aplicação).
    const existing = await prisma.agendaUnavailability.findFirst({ where: { id, companyId, ...(userBranchId ? { branchId: userBranchId } : {}) } });
    if (!existing) throw new AppError('Indisponibilidade não encontrada.', 404, 'NOT_FOUND');
    const removed = await prisma.agendaUnavailability.deleteMany({ where: { id, companyId, branchId: existing.branchId } });
    if (removed.count === 0) throw new AppError('Indisponibilidade não encontrada.', 404, 'NOT_FOUND');
    return existing;
  },
};
