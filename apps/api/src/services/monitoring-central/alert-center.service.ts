/**
 * CENTRAL DE ALERTAS (Super Admin): listagem com filtros e o ciclo de tratamento — reconhecer, assumir, iniciar tratamento, resolver (com justificativa), reabrir e anotar. Cada ação
 * grava um evento imutável (monitoring_alert_events) e a transição é validada contra o estado atual (`actionRefusal`). A causa provável só aparece quando há evidência (o detalhe e
 * o valor/limite medidos); a orientação de diagnóstico vem do catálogo por tipo (model.ts). Alerta resolvido à mão que volta a ocorrer reabre sozinho (reincidência), como antes.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@ln-system/database';
import { AppError, ConflictError } from '@ln-system/shared';
import { asPlatform } from './settings.service';
import { listAlertEvents, recordAlertEvent, type AlertEventKind } from './alert-events';
import { actionRefusal, alertCategory, alertGuidance, alertStatus, type AlertAction, type AlertCategory, type AlertStatus } from './model';

export interface AlertFilters {
  status?: AlertStatus;
  severity?: string;
  category?: AlertCategory;
  companyId?: string;
  /** `central` = só infraestrutura da plataforma (sem empresa). */
  scope?: 'central' | 'company';
  q?: string;
  page?: number;
  limit?: number;
}

const SEVERITIES = ['ATTENTION', 'CRITICAL', 'OFFLINE'];

function present(alert: Prisma.MonitoringAlertGetPayload<object>, names: Map<string, string>, users: Map<string, string>) {
  return {
    id: alert.id,
    type: alert.type,
    category: alertCategory(alert.type),
    severity: alert.severity,
    status: alertStatus(alert),
    source: alert.source,
    companyId: alert.companyId,
    companyName: alert.companyId ? (names.get(alert.companyId) ?? null) : null,
    branchId: alert.branchId,
    deviceId: alert.deviceId,
    detail: alert.detail,
    value: alert.value,
    threshold: alert.threshold,
    occurrences: alert.occurrences,
    startedAt: alert.startedAt,
    lastSeenAt: alert.lastSeenAt,
    endedAt: alert.endedAt,
    assignedTo: alert.assignedTo,
    assignedToName: alert.assignedTo ? (users.get(alert.assignedTo) ?? null) : null,
    acknowledgedAt: alert.acknowledgedAt,
    acknowledgedBy: alert.acknowledgedBy,
    acknowledgedByName: alert.acknowledgedBy ? (users.get(alert.acknowledgedBy) ?? null) : null,
    resolvedBy: alert.resolvedBy,
    resolutionNote: alert.resolutionNote,
    // causa provável SÓ com evidência medida: o detalhe e o valor contra o limite que o disparou
    evidence: alert.value !== null && alert.threshold !== null ? `valor medido ${alert.value} contra limite ${alert.threshold}` : (alert.detail ?? null),
    guidance: alertGuidance(alert.type),
  };
}

async function lookups(companyIds: string[], userIds: string[]) {
  const [companies, users] = await asPlatform(() =>
    Promise.all([
      companyIds.length ? prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ])
  );
  return { names: new Map(companies.map((c) => [c.id, c.name])), users: new Map(users.map((u) => [u.id, u.name])) };
}

export async function listAlerts(f: AlertFilters) {
  const limit = Math.min(Math.max(f.limit ?? 25, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const where: Prisma.MonitoringAlertWhereInput = {};
  if (f.status === 'RESOLVED') where.endedAt = { not: null };
  else if (f.status) {
    where.endedAt = null;
    where.handling = f.status;
  }
  if (f.severity && SEVERITIES.includes(f.severity)) where.severity = f.severity;
  if (f.companyId) where.companyId = f.companyId;
  else if (f.scope === 'central') where.companyId = null;
  else if (f.scope === 'company') where.companyId = { not: null };
  if (f.q?.trim()) where.OR = [{ type: { contains: f.q.trim(), mode: 'insensitive' } }, { detail: { contains: f.q.trim(), mode: 'insensitive' } }];

  const all = await asPlatform(() => prisma.monitoringAlert.findMany({ where, orderBy: [{ endedAt: { sort: 'desc', nulls: 'first' } }, { startedAt: 'desc' }], take: 1000 }));
  // a categoria é derivada do tipo: o filtro roda aqui (no máximo 1000 linhas), depois da consulta
  const filtered = f.category ? all.filter((a) => alertCategory(a.type) === f.category) : all;
  const pageRows = filtered.slice((page - 1) * limit, page * limit);
  const { names, users } = await lookups(
    [...new Set(pageRows.map((a) => a.companyId).filter((x): x is string => Boolean(x)))],
    [...new Set(pageRows.flatMap((a) => [a.assignedTo, a.acknowledgedBy]).filter((x): x is string => Boolean(x)))]
  );
  const open = filtered.filter((a) => !a.endedAt);
  return {
    total: filtered.length,
    page,
    limit,
    capped: all.length >= 1000,
    summary: {
      open: open.length,
      unhandled: open.filter((a) => a.handling === 'OPEN').length,
      bySeverity: { OFFLINE: open.filter((a) => a.severity === 'OFFLINE').length, CRITICAL: open.filter((a) => a.severity === 'CRITICAL').length, ATTENTION: open.filter((a) => a.severity === 'ATTENTION').length },
    },
    items: pageRows.map((a) => present(a, names, users)),
  };
}

export async function getAlert(id: string) {
  const alert = await asPlatform(() => prisma.monitoringAlert.findUnique({ where: { id } }));
  if (!alert) throw new AppError('Alerta não encontrado.', 404, 'ALERT_NOT_FOUND');
  const events = await listAlertEvents(id);
  const { names, users } = await lookups(alert.companyId ? [alert.companyId] : [], [...new Set([alert.assignedTo, alert.acknowledgedBy, ...events.map((e) => e.actorId)].filter((x): x is string => Boolean(x)))]);
  return {
    ...present(alert, names, users),
    events: events.map((e) => ({ id: e.id, kind: e.kind, note: e.note, createdAt: e.createdAt, actorId: e.actorId, actorName: e.actorId ? (users.get(e.actorId) ?? null) : 'sistema' })),
  };
}

/** Super Admins que podem receber um alerta (responsável). */
export async function listAssignees() {
  return asPlatform(() => prisma.user.findMany({ where: { userType: 'SUPER_ADMIN', isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }));
}

export interface TransitionInput {
  action: AlertAction;
  note?: string;
  assigneeId?: string | null;
}

const EVENT_FOR: Record<AlertAction, AlertEventKind> = {
  ACKNOWLEDGE: 'ACKNOWLEDGED',
  ASSIGN: 'ASSIGNED',
  START: 'IN_PROGRESS',
  RESOLVE: 'RESOLVED',
  REOPEN: 'REOPENED',
  NOTE: 'NOTE',
};

export const ACTIONS = Object.keys(EVENT_FOR) as AlertAction[];

export async function transition(alertId: string, actorId: string, input: TransitionInput) {
  if (!ACTIONS.includes(input.action)) throw new AppError('Ação inválida.', 400, 'INVALID_ALERT_ACTION');
  const note = input.note?.trim() ?? '';
  if (note.length > 500) throw new AppError('A anotação pode ter no máximo 500 caracteres.', 400, 'NOTE_TOO_LONG');
  if ((input.action === 'RESOLVE' || input.action === 'NOTE') && note.length < 3) {
    throw new AppError(input.action === 'RESOLVE' ? 'Informe como o alerta foi resolvido (pelo menos 3 caracteres).' : 'A anotação não pode ficar vazia.', 400, 'NOTE_REQUIRED');
  }
  const alert = await asPlatform(() => prisma.monitoringAlert.findUnique({ where: { id: alertId } }));
  if (!alert) throw new AppError('Alerta não encontrado.', 404, 'ALERT_NOT_FOUND');
  const refusal = actionRefusal(alertStatus(alert), input.action);
  if (refusal) throw new ConflictError(refusal, 'ALERT_TRANSITION_REFUSED');

  const now = new Date();
  let data: Prisma.MonitoringAlertUpdateManyMutationInput = {};
  let guard: Prisma.MonitoringAlertWhereInput = { id: alertId };
  let eventNote: string | null = note || null;
  switch (input.action) {
    case 'ACKNOWLEDGE':
      data = { handling: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedBy: actorId };
      guard = { id: alertId, endedAt: null, handling: 'OPEN' };
      break;
    case 'START':
      data = { handling: 'IN_PROGRESS', ...(alert.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedBy: actorId }), ...(alert.assignedTo ? {} : { assignedTo: actorId }) };
      guard = { id: alertId, endedAt: null, handling: { not: 'IN_PROGRESS' } };
      break;
    case 'ASSIGN': {
      const assignee = input.assigneeId ?? null;
      if (assignee) {
        const user = await asPlatform(() => prisma.user.findFirst({ where: { id: assignee, userType: 'SUPER_ADMIN', isActive: true }, select: { id: true, name: true } }));
        if (!user) throw new AppError('O responsável precisa ser um Super Admin ativo.', 400, 'INVALID_ASSIGNEE');
        eventNote = `responsável: ${user.name}${note ? ` — ${note}` : ''}`;
      } else {
        eventNote = `responsável removido${note ? ` — ${note}` : ''}`;
      }
      data = { assignedTo: assignee };
      guard = { id: alertId, endedAt: null };
      break;
    }
    case 'RESOLVE':
      data = { endedAt: now, lastSeenAt: now, resolvedBy: actorId, resolutionNote: note };
      guard = { id: alertId, endedAt: null };
      break;
    case 'REOPEN':
      data = { endedAt: null, handling: 'OPEN', acknowledgedAt: null, acknowledgedBy: null, resolvedBy: null, resolutionNote: null, lastSeenAt: now };
      guard = { id: alertId, endedAt: { not: null } };
      break;
    case 'NOTE':
      break;
  }
  if (input.action !== 'NOTE') {
    try {
      const done = await asPlatform(() => prisma.monitoringAlert.updateMany({ where: guard, data }));
      if (done.count !== 1) throw new ConflictError('O alerta mudou de estado enquanto você agia. Recarregue e tente de novo.', 'ALERT_STATE_CHANGED');
    } catch (error) {
      // reabrir um alerta resolvido quando já existe OUTRO aberto para o mesmo tipo e alvo (índice de um aberto por tipo+alvo)
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictError('Já existe um alerta aberto para este mesmo problema e alvo.', 'ALERT_ALREADY_OPEN');
      throw error;
    }
  }
  await recordAlertEvent({ alertId, companyId: alert.companyId, kind: EVENT_FOR[input.action], actorId, note: eventNote });
  return getAlert(alertId);
}
