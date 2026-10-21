import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, runInTransaction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { policyService } from './policy.service';

/**
 * Horário de funcionamento por empresa e filial (docs/CORTEX/POLICIES.md, "Empresa e filial").
 *
 * A semana da filial (se cadastrada) substitui a da empresa; sem nenhuma, "não configurado" (nada é bloqueado por
 * horário). Exceções de calendário (feriado, fechamento excepcional, horário especial) valem por data: a da filial tem
 * prioridade sobre a da empresa. Horários são locais, no fuso da política `company.timezone`.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(HHMM, 'Use o formato HH:MM');
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const WEEKDAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export const dayInputSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    isClosed: z.boolean().default(false),
    opensAt: time.nullable().optional(),
    closesAt: time.nullable().optional(),
    breakStart: time.nullable().optional(),
    breakEnd: time.nullable().optional(),
  })
  .superRefine((d, ctx) => {
    const name = WEEKDAY_NAMES[d.weekday];
    if (d.isClosed) return;
    if (!d.opensAt || !d.closesAt) {
      ctx.addIssue({ code: 'custom', message: `${name}: informe abertura e fechamento (ou marque como fechado)` });
      return;
    }
    if (minutes(d.opensAt) >= minutes(d.closesAt)) ctx.addIssue({ code: 'custom', message: `${name}: a abertura precisa ser antes do fechamento` });
    if (Boolean(d.breakStart) !== Boolean(d.breakEnd)) ctx.addIssue({ code: 'custom', message: `${name}: informe início e fim do intervalo` });
    if (d.breakStart && d.breakEnd) {
      const [bs, be] = [minutes(d.breakStart), minutes(d.breakEnd)];
      if (bs >= be || bs <= minutes(d.opensAt) || be >= minutes(d.closesAt)) {
        ctx.addIssue({ code: 'custom', message: `${name}: o intervalo precisa ficar dentro do expediente` });
      }
    }
  });

export const weekInputSchema = z
  .array(dayInputSchema)
  .length(7, 'Informe os 7 dias da semana')
  .refine((days) => new Set(days.map((d) => d.weekday)).size === 7, 'Cada dia da semana deve aparecer uma vez');

export const exceptionInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD'),
    kind: z.enum(['HOLIDAY', 'CLOSED', 'SPECIAL_HOURS']),
    opensAt: time.nullable().optional(),
    closesAt: time.nullable().optional(),
    description: z.string().trim().max(200).nullable().optional(),
  })
  .superRefine((e, ctx) => {
    if (Number.isNaN(new Date(`${e.date}T00:00:00Z`).getTime())) ctx.addIssue({ code: 'custom', message: 'Data inválida' });
    if (e.kind === 'SPECIAL_HOURS') {
      if (!e.opensAt || !e.closesAt) ctx.addIssue({ code: 'custom', message: 'Horário especial: informe abertura e fechamento' });
      else if (minutes(e.opensAt) >= minutes(e.closesAt)) ctx.addIssue({ code: 'custom', message: 'Horário especial: a abertura precisa ser antes do fechamento' });
    }
  });

type DayRow = { weekday: number; isClosed: boolean; opensAt: string | null; closesAt: string | null; breakStart: string | null; breakEnd: string | null };

/** Data (AAAA-MM-DD), dia da semana e minutos do dia no fuso informado. */
export function localParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

async function assertBranchOfCompany(companyId: string, branchId: string) {
  const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId }, select: { id: true } });
  if (!branch) throw new AppError('Filial não encontrada nesta empresa', 400, 'BRANCH_NOT_FOUND');
}

const toDay = (r: DayRow) => ({
  weekday: r.weekday,
  isClosed: r.isClosed,
  opensAt: r.opensAt,
  closesAt: r.closesAt,
  breakStart: r.breakStart,
  breakEnd: r.breakEnd,
});

export class BusinessHoursService {
  /** Semana efetiva (filial → empresa) + exceções da empresa e da filial. */
  async getSchedule(companyId: string, branchId?: string | null) {
    const rows = await prisma.businessHours.findMany({
      where: { companyId, OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] },
      orderBy: { weekday: 'asc' },
    });
    const branchRows = branchId ? rows.filter((r) => r.branchId === branchId) : [];
    const companyRows = rows.filter((r) => r.branchId === null);
    const effective = branchRows.length ? branchRows : companyRows;
    const source: 'BRANCH' | 'COMPANY' | 'NONE' = branchRows.length ? 'BRANCH' : companyRows.length ? 'COMPANY' : 'NONE';
    const exceptions = await prisma.businessCalendarException.findMany({
      where: { companyId, OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] },
      orderBy: { date: 'asc' },
    });
    return {
      source,
      days: effective.map(toDay),
      companyDays: companyRows.map(toDay),
      exceptions: exceptions.map((e) => ({
        id: e.id,
        branchId: e.branchId,
        date: e.date.toISOString().slice(0, 10),
        kind: e.kind,
        opensAt: e.opensAt,
        closesAt: e.closesAt,
        description: e.description,
      })),
      timezone: await policyService.get(companyId, branchId, 'company.timezone'),
    };
  }

  /** Grava a semana inteira da empresa (branchId nulo) ou da filial. */
  async setWeek(input: { companyId: string; branchId?: string | null; days: unknown; userId: string }) {
    const parsed = weekInputSchema.safeParse(input.days);
    if (!parsed.success) throw new AppError(parsed.error.issues.map((i) => i.message).join('; '), 400, 'INVALID_BUSINESS_HOURS');
    const branchId = input.branchId ?? null;
    if (branchId) await assertBranchOfCompany(input.companyId, branchId);
    return runInTransaction(async (tx) => {
      const before = await tx.businessHours.findMany({ where: { companyId: input.companyId, branchId }, orderBy: { weekday: 'asc' } });
      await tx.businessHours.deleteMany({ where: { companyId: input.companyId, branchId } });
      await tx.businessHours.createMany({
        data: parsed.data.map((d) => ({
          companyId: input.companyId,
          branchId,
          weekday: d.weekday,
          isClosed: d.isClosed,
          opensAt: d.isClosed ? null : d.opensAt ?? null,
          closesAt: d.isClosed ? null : d.closesAt ?? null,
          breakStart: d.isClosed ? null : d.breakStart ?? null,
          breakEnd: d.isClosed ? null : d.breakEnd ?? null,
          updatedBy: input.userId,
        })),
      });
      return { branchId, before: before.map(toDay), after: parsed.data };
    });
  }

  /** Filial volta a seguir o horário da empresa. */
  async clearBranchWeek(companyId: string, branchId: string) {
    await assertBranchOfCompany(companyId, branchId);
    const removed = await prisma.businessHours.deleteMany({ where: { companyId, branchId } });
    return { branchId, removed: removed.count };
  }

  async addException(input: { companyId: string; branchId?: string | null; data: unknown; userId: string }) {
    const parsed = exceptionInputSchema.safeParse(input.data);
    if (!parsed.success) throw new AppError(parsed.error.issues.map((i) => i.message).join('; '), 400, 'INVALID_CALENDAR_EXCEPTION');
    const branchId = input.branchId ?? null;
    if (branchId) await assertBranchOfCompany(input.companyId, branchId);
    const e = parsed.data;
    try {
      return await prisma.businessCalendarException.create({
        data: {
          companyId: input.companyId,
          branchId,
          date: new Date(`${e.date}T00:00:00Z`),
          kind: e.kind,
          opensAt: e.kind === 'SPECIAL_HOURS' ? e.opensAt ?? null : null,
          closesAt: e.kind === 'SPECIAL_HOURS' ? e.closesAt ?? null : null,
          description: e.description ?? null,
          createdBy: input.userId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('Já existe uma exceção de calendário para esta data', 409, 'CALENDAR_EXCEPTION_EXISTS');
      }
      throw err;
    }
  }

  async removeException(companyId: string, id: string) {
    const existing = await prisma.businessCalendarException.findFirst({ where: { id, companyId } });
    if (!existing) throw new AppError('Exceção de calendário não encontrada', 404, 'NOT_FOUND');
    await prisma.businessCalendarException.delete({ where: { id } });
    return existing;
  }

  /**
   * A empresa/filial está funcionando neste instante? `configured: false` quando não há horário cadastrado — quem chama
   * decide (a agenda, por exemplo, não bloqueia nada sem horário cadastrado).
   */
  async isOpenAt(companyId: string, branchId: string | null | undefined, at: Date) {
    return openAtIn(await this.getSchedule(companyId, branchId), branchId, at);
  }

  /** A janela [start, end) cabe INTEIRA num período de funcionamento do mesmo dia? (agenda com duração) */
  async isWindowOpen(companyId: string, branchId: string | null | undefined, start: Date, end: Date) {
    return windowOpenIn(await this.getSchedule(companyId, branchId), branchId, start, end);
  }
}

export type BusinessSchedule = Awaited<ReturnType<BusinessHoursService['getSchedule']>>;
export type OpenCheck = { configured: boolean; open: boolean; reason: string | null };

const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function exceptionFor(schedule: BusinessSchedule, branchId: string | null | undefined, date: string) {
  return (
    (branchId ? schedule.exceptions.find((e) => e.date === date && e.branchId === branchId) : undefined) ??
    schedule.exceptions.find((e) => e.date === date && e.branchId === null)
  );
}

/** Mesma regra de isOpenAt, sem ir ao banco (a agenda avalia vários horários com um único cadastro lido). */
export function openAtIn(schedule: BusinessSchedule, branchId: string | null | undefined, at: Date): OpenCheck {
  const local = localParts(at, schedule.timezone);
  const exception = exceptionFor(schedule, branchId, local.date);
  if (exception) {
    if (exception.kind === 'SPECIAL_HOURS' && exception.opensAt && exception.closesAt) {
      const open = local.minutes >= minutes(exception.opensAt) && local.minutes < minutes(exception.closesAt);
      return { configured: true, open, reason: open ? null : `Horário especial em ${local.date}: ${exception.opensAt}–${exception.closesAt}` };
    }
    return { configured: true, open: false, reason: `Sem funcionamento em ${local.date}${exception.description ? ` (${exception.description})` : ''}` };
  }
  if (schedule.source === 'NONE') return { configured: false, open: true, reason: null };
  const day = schedule.days.find((d) => d.weekday === local.weekday);
  if (!day || day.isClosed || !day.opensAt || !day.closesAt) {
    return { configured: true, open: false, reason: `Sem funcionamento aos ${WEEKDAY_NAMES[local.weekday]}s` };
  }
  const inDay = local.minutes >= minutes(day.opensAt) && local.minutes < minutes(day.closesAt);
  const inBreak = Boolean(day.breakStart && day.breakEnd && local.minutes >= minutes(day.breakStart) && local.minutes < minutes(day.breakEnd));
  const open = inDay && !inBreak;
  return {
    configured: true,
    open,
    reason: open
      ? null
      : inBreak
        ? `Intervalo das ${day.breakStart} às ${day.breakEnd}`
        : `Fora do horário de funcionamento (${day.opensAt}–${day.closesAt})`,
  };
}

/**
 * A janela [start, end) cabe inteira num período de funcionamento? O início segue openAtIn (mesmas mensagens); o fim
 * não pode passar do fechamento, nem atravessar o intervalo, nem cair em outro dia. Minutos locais somados à duração:
 * o fuso do Brasil não tem horário de verão (ver AGENDA.md, limitações).
 */
export function windowOpenIn(schedule: BusinessSchedule, branchId: string | null | undefined, start: Date, end: Date): OpenCheck {
  const first = openAtIn(schedule, branchId, start);
  if (!first.configured || !first.open) return first;
  const local = localParts(start, schedule.timezone);
  const duration = Math.round((end.getTime() - start.getTime()) / 60_000);
  const endMinutes = local.minutes + duration;
  const exception = exceptionFor(schedule, branchId, local.date);
  const day = schedule.days.find((d) => d.weekday === local.weekday);
  // O início está aberto: ou há horário especial, ou o dia tem expediente.
  const periods: Array<[number, number]> = exception
    ? [[minutes(exception.opensAt!), minutes(exception.closesAt!)]]
    : day!.breakStart && day!.breakEnd
      ? [
          [minutes(day!.opensAt!), minutes(day!.breakStart)],
          [minutes(day!.breakEnd), minutes(day!.closesAt!)],
        ]
      : [[minutes(day!.opensAt!), minutes(day!.closesAt!)]];
  const index = periods.findIndex(([a, b]) => local.minutes >= a && local.minutes < b);
  const period = periods[index];
  if (endMinutes <= period[1]) return { configured: true, open: true, reason: null };
  const span = `${hhmm(local.minutes)}–${hhmm(endMinutes)}`;
  const reason =
    !exception && periods.length === 2 && index === 0
      ? `o atendimento de ${duration} min (${span}) passa pelo intervalo das ${day!.breakStart} às ${day!.breakEnd}. Escolha outro horário ou uma duração menor.`
      : `o atendimento de ${duration} min (${span}) termina depois do fechamento (${hhmm(period[1])}). Escolha um horário mais cedo ou uma duração menor.`;
  return { configured: true, open: false, reason };
}

export const businessHoursService = new BusinessHoursService();
export default businessHoursService;
