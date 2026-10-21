/**
 * FUNIL COMERCIAL (Super Admin): interessado → demonstração → proposta → implantação → cliente ativo (e suspensão/cancelamento). Não havia CRM no projeto: esta é a estrutura MÍNIMA
 * e aditiva (commercial_leads + commercial_lead_events). Nada é inventado: sem oportunidade registrada o funil fica vazio e a tela diz o que ainda não foi coletado. O que JÁ é real
 * e independe do registro manual — empresas criadas por mês e empresas em implantação paradas — vem direto da tabela de empresas, sempre identificado como tal.
 */
import { Prisma } from '@prisma/client';
import { prisma, runInTransaction } from '@ln-system/database';
import { AppError, ConflictError } from '@ln-system/shared';
import { asPlatform } from './settings.service';
import { ALL_STAGES, FUNNEL_STAGES, INDICATOR_DEFINITIONS, STAGE_LABELS, computeFunnel, isStage, monthlyCounts, type FunnelStage } from './model';
import { companiesSnapshot } from './overview.service';

const DAY_MS = 86_400_000;

function cleanText(v: unknown, max: number, field: string, required = false): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new AppError(`Informe ${field}.`, 400, 'INVALID_LEAD');
    return null;
  }
  if (typeof v !== 'string') throw new AppError(`${field} inválido.`, 400, 'INVALID_LEAD');
  const t = v.trim();
  if (required && t.length < 2) throw new AppError(`${field} precisa ter pelo menos 2 caracteres.`, 400, 'INVALID_LEAD');
  if (t.length > max) throw new AppError(`${field} pode ter no máximo ${max} caracteres.`, 400, 'INVALID_LEAD');
  return t || null;
}

export async function getFunnel(now = new Date(), stuckDays = 14) {
  const [leads, events, companies, linkedIds, snapshot] = await asPlatform(() =>
    Promise.all([
      prisma.commercialLead.findMany({ select: { id: true, stage: true, stageEnteredAt: true, createdAt: true, companyId: true } }),
      prisma.commercialLeadEvent.findMany({ select: { leadId: true, fromStage: true, toStage: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
      prisma.company.findMany({ select: { id: true, name: true, isActive: true, createdAt: true } }),
      prisma.commercialLead.findMany({ where: { companyId: { not: null } }, select: { companyId: true } }),
      companiesSnapshot(),
    ])
  );
  const funnel = computeFunnel(leads, events, now, stuckDays);
  const linked = new Set(linkedIds.map((l) => l.companyId as string));
  const stuckCompanies = await stuckOnboardingCompanies(companies, now, stuckDays);
  // anotação na mesma etapa (ex.: vínculo com a empresa) não é mudança de etapa: fora das contagens mensais
  const moves = events.filter((e) => e.fromStage === null || e.fromStage !== e.toStage);
  const activations = moves.filter((e) => e.toStage === 'ACTIVE').map((e) => e.createdAt);
  const cancellations = moves.filter((e) => e.toStage === 'CANCELLED').map((e) => e.createdAt);
  const suspensions = moves.filter((e) => e.toStage === 'SUSPENDED').map((e) => e.createdAt);
  const first = events[0]?.createdAt ?? null;
  return {
    generatedAt: now.toISOString(),
    definition: INDICATOR_DEFINITIONS.funnel,
    stages: ALL_STAGES.map((s) => ({ stage: s, label: STAGE_LABELS[s], current: funnel.current[s], reached: funnel.reached[s], avgDaysInStage: funnel.avgDaysInStage[s], funnel: (FUNNEL_STAGES as readonly string[]).includes(s) })),
    conversions: funnel.conversions.map((c) => ({ ...c, fromLabel: STAGE_LABELS[c.from], toLabel: STAGE_LABELS[c.to] })),
    totals: { leads: funnel.total, events: events.length },
    stuckOnboarding: {
      leads: funnel.stuckOnboarding,
      companies: stuckCompanies,
      thresholdDays: stuckDays,
      note: 'Empresas ativas em implantação (sem licença ativa ou sem nenhum acesso) criadas há mais que o limite — vem do cadastro real de empresas, com ou sem oportunidade registrada.',
    },
    evolution: {
      newCompaniesPerMonth: monthlyCounts(companies.map((c) => c.createdAt)),
      newLeadsPerMonth: monthlyCounts(leads.map((l) => l.createdAt)),
      activationsPerMonth: monthlyCounts(activations),
      cancellationsPerMonth: monthlyCounts(cancellations),
      suspensionsPerMonth: monthlyCounts(suspensions),
    },
    companies: snapshot,
    coverage: {
      firstEventAt: first?.toISOString() ?? null,
      companiesTotal: companies.length,
      companiesLinkedToLeads: companies.filter((c) => linked.has(c.id)).length,
      companiesWithoutLead: companies.filter((c) => !linked.has(c.id)).length,
      notes: [
        funnel.total === 0 ? 'Nenhuma oportunidade registrada: o funil só passa a existir quando as oportunidades forem cadastradas aqui. Não há histórico comercial anterior.' : null,
        'Tempo médio por etapa e conversão só podem ser calculados a partir do início do registro; permanências ainda abertas não entram na média.',
        'Empresas sem oportunidade vinculada existem no cadastro mas não têm histórico de aquisição: elas não entram na conversão.',
      ].filter((n): n is string => n !== null),
    },
  };
}

async function stuckOnboardingCompanies(companies: Array<{ id: string; name: string; isActive: boolean; createdAt: Date }>, now: Date, stuckDays: number) {
  const old = companies.filter((c) => c.isActive && now.getTime() - c.createdAt.getTime() > stuckDays * DAY_MS);
  if (old.length === 0) return [];
  const ids = old.map((c) => c.id);
  const [licenses, logins] = await asPlatform(() =>
    Promise.all([
      prisma.license.groupBy({ by: ['companyId'], where: { companyId: { in: ids }, status: 'ACTIVE' } }),
      prisma.user.groupBy({ by: ['companyId'], where: { companyId: { in: ids }, lastLoginAt: { not: null } } }),
    ])
  );
  const withLicense = new Set(licenses.map((l) => l.companyId));
  const withLogin = new Set(logins.map((l) => l.companyId as string));
  return old
    .filter((c) => !(withLicense.has(c.id) && withLogin.has(c.id)))
    .map((c) => ({ id: c.id, name: c.name, days: Math.floor((now.getTime() - c.createdAt.getTime()) / DAY_MS), missing: [!withLicense.has(c.id) ? 'licença ativa' : null, !withLogin.has(c.id) ? 'primeiro acesso' : null].filter(Boolean) as string[] }))
    .sort((a, b) => b.days - a.days);
}

export async function listLeads(params: { stage?: string; q?: string; page?: number; limit?: number }) {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  const where: Prisma.CommercialLeadWhereInput = {};
  if (params.stage) {
    if (!isStage(params.stage)) throw new AppError('Etapa inválida.', 400, 'INVALID_STAGE');
    where.stage = params.stage;
  }
  if (params.q?.trim()) where.name = { contains: params.q.trim(), mode: 'insensitive' };
  const [total, rows] = await asPlatform(() =>
    Promise.all([
      prisma.commercialLead.count({ where }),
      prisma.commercialLead.findMany({ where, orderBy: { stageEnteredAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { company: { select: { id: true, name: true } } } }),
    ])
  );
  return {
    total,
    page,
    limit,
    items: rows.map((l) => ({ id: l.id, name: l.name, contact: l.contact, source: l.source, stage: l.stage, stageLabel: STAGE_LABELS[l.stage as FunnelStage] ?? l.stage, stageEnteredAt: l.stageEnteredAt, closedReason: l.closedReason, createdAt: l.createdAt, company: l.company })),
  };
}

export async function createLead(input: { name?: unknown; contact?: unknown; source?: unknown; stage?: unknown; companyId?: unknown }, actorId: string) {
  const name = cleanText(input.name, 120, 'o nome da oportunidade', true) as string;
  const contact = cleanText(input.contact, 200, 'o contato');
  const source = cleanText(input.source, 80, 'a origem');
  const stage = input.stage === undefined || input.stage === null || input.stage === '' ? 'INTERESTED' : input.stage;
  if (!isStage(stage)) throw new AppError('Etapa inválida.', 400, 'INVALID_STAGE');
  const companyId = typeof input.companyId === 'string' && input.companyId ? input.companyId : null;
  if (companyId) {
    const [company, linked] = await asPlatform(() => Promise.all([prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }), prisma.commercialLead.findUnique({ where: { companyId }, select: { id: true } })]));
    if (!company) throw new AppError('Empresa não encontrada.', 404, 'COMPANY_NOT_FOUND');
    if (linked) throw new ConflictError('Esta empresa já está vinculada a outra oportunidade.', 'COMPANY_ALREADY_LINKED');
  }
  const lead = await asPlatform(() =>
    runInTransaction(async (tx) => {
      const created = await tx.commercialLead.create({ data: { name, contact, source, stage, companyId, createdBy: actorId } });
      await tx.commercialLeadEvent.create({ data: { leadId: created.id, fromStage: null, toStage: stage, actorId, note: 'oportunidade registrada' } });
      return created;
    })
  );
  return lead;
}

export async function moveLead(id: string, toStage: unknown, actorId: string, note?: unknown) {
  if (!isStage(toStage)) throw new AppError('Etapa inválida.', 400, 'INVALID_STAGE');
  const text = cleanText(note, 300, 'a anotação');
  if ((toStage === 'CANCELLED' || toStage === 'SUSPENDED') && (!text || text.length < 3)) throw new AppError('Informe o motivo (pelo menos 3 caracteres) ao suspender ou cancelar.', 400, 'REASON_REQUIRED');
  const lead = await asPlatform(() => prisma.commercialLead.findUnique({ where: { id } }));
  if (!lead) throw new AppError('Oportunidade não encontrada.', 404, 'LEAD_NOT_FOUND');
  if (lead.stage === toStage) throw new ConflictError('A oportunidade já está nesta etapa.', 'SAME_STAGE');
  const now = new Date();
  await asPlatform(() =>
    runInTransaction(async (tx) => {
      const done = await tx.commercialLead.updateMany({
        where: { id, stage: lead.stage },
        data: { stage: toStage, stageEnteredAt: now, closedReason: toStage === 'CANCELLED' || toStage === 'SUSPENDED' ? text : null },
      });
      if (done.count !== 1) throw new ConflictError('A oportunidade mudou de etapa enquanto você agia. Recarregue.', 'LEAD_STATE_CHANGED');
      await tx.commercialLeadEvent.create({ data: { leadId: id, fromStage: lead.stage, toStage, actorId, note: text } });
    })
  );
  return asPlatform(() => prisma.commercialLead.findUnique({ where: { id } }));
}

export async function linkCompany(id: string, companyId: unknown, actorId: string) {
  if (typeof companyId !== 'string' || !companyId) throw new AppError('Informe a empresa.', 400, 'INVALID_LEAD');
  const [lead, company, linked] = await asPlatform(() =>
    Promise.all([prisma.commercialLead.findUnique({ where: { id } }), prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } }), prisma.commercialLead.findUnique({ where: { companyId }, select: { id: true } })])
  );
  if (!lead) throw new AppError('Oportunidade não encontrada.', 404, 'LEAD_NOT_FOUND');
  if (!company) throw new AppError('Empresa não encontrada.', 404, 'COMPANY_NOT_FOUND');
  if (linked && linked.id !== id) throw new ConflictError('Esta empresa já está vinculada a outra oportunidade.', 'COMPANY_ALREADY_LINKED');
  await asPlatform(() =>
    runInTransaction(async (tx) => {
      await tx.commercialLead.update({ where: { id }, data: { companyId } });
      await tx.commercialLeadEvent.create({ data: { leadId: id, fromStage: lead.stage, toStage: lead.stage, actorId, note: `vinculada à empresa ${company.name}` } });
    })
  );
  return asPlatform(() => prisma.commercialLead.findUnique({ where: { id } }));
}
