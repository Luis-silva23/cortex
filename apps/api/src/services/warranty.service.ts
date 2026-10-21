import { Prisma } from '@prisma/client';
import { prisma, runInTransaction } from '@ln-system/database';
import { AppError, ConflictError } from '@ln-system/shared';
import type { WarrantyDecisionInput } from '@ln-system/shared/src/validators/pdv.validators';
import { addMonthsClamped } from './revision.service';
import { localParts } from './business-hours.service';
import { policyService } from './policy.service';

/**
 * Garantia de OS (docs/CORTEX/policies/GARANTIA.md, regra oficial do CÓRTEX decidida em 2026-09-27).
 *
 * - A decisão (sem garantia / com garantia) é tomada no ENCERRAMENTO da OS, na mesma transação da mudança de status
 *   (service-order.service.ts::transitionStatus). Com `warranty.requireDecisionOnClose` e `warranty.enabled`, encerrar
 *   sem decisão é recusado (400 WARRANTY_DECISION_REQUIRED).
 * - O INÍCIO da garantia é a ENTREGA (deliveryDate, gravada na transição para ENTREGA), não o encerramento: é quando o
 *   serviço termina e o veículo volta ao cliente (CDC art. 26 §1º conta o prazo "a partir da entrega efetiva do produto
 *   ou do término da execução dos serviços"). O ENCERRAMENTO é administrativo/financeiro (exige pagamento) e pode ocorrer
 *   dias depois; usar a data dele encurtaria a garantia real do cliente. Sem deliveryDate (dado antigo), vale o momento
 *   do encerramento.
 * - Validade = último dia do prazo, até 23:59:59 no fuso da empresa (`company.timezone`). Meses/anos somam sem estourar
 *   o mês (31/01 + 1 mês = 28/02 ou 29/02) — `addMonthsClamped`. Dias: data de início + N dias (o dia da entrega não
 *   conta, como no Código Civil art. 132).
 * - Km: km inicial = informado no encerramento ou km de saída da OS ou, na falta, km de entrada; km limite = inicial +
 *   limite. Vigente = agora ≤ validade E (sem limite de km OU km atual < km limite) — o que ocorrer primeiro.
 */

export type WarrantyCoverage = 'SERVICE' | 'PART' | 'SERVICE_AND_PART';
export type WarrantyDurationUnit = 'DAYS' | 'MONTHS' | 'YEARS';
export type WarrantyExpiredBy = 'DATE' | 'KM' | null;
export type ClaimStatus = 'OPEN' | 'ACCEPTED' | 'REJECTED' | 'RESOLVED';

const DAY_MS = 86_400_000;

const UNIT_LABEL: Record<WarrantyDurationUnit, [string, string]> = {
  DAYS: ['dia', 'dias'],
  MONTHS: ['mês', 'meses'],
  YEARS: ['ano', 'anos'],
};

export const durationLabel = (value: number, unit: WarrantyDurationUnit) => `${value} ${UNIT_LABEL[unit][value === 1 ? 0 : 1]}`;

const formatKm = (km: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(km);

/** Diferença (min) entre o horário local do fuso e UTC no instante dado (ex.: São Paulo = −180). */
function tzOffsetMinutes(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const [y, m, d] = p.date.split('-').map(Number);
  const localAsUtc = Date.UTC(y, m - 1, d, Math.floor(p.minutes / 60), p.minutes % 60);
  const atMinute = Math.floor(at.getTime() / 60_000) * 60_000;
  return Math.round((localAsUtc - atMinute) / 60_000);
}

/** 23:59:59.999 do dia de calendário (UTC y/m/d de `day`) no fuso informado. */
function endOfLocalDay(day: Date, timeZone: string): Date {
  const naive = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 59, 59, 999);
  return new Date(naive - tzOffsetMinutes(new Date(naive), timeZone) * 60_000);
}

/** Validade (fim do último dia) de uma garantia que começa em `startDate`. */
export function computeValidUntil(startDate: Date, value: number, unit: WarrantyDurationUnit, timeZone: string): Date {
  const [y, m, d] = localParts(startDate, timeZone).date.split('-').map(Number);
  const startDay = new Date(Date.UTC(y, m - 1, d));
  const lastDay = unit === 'DAYS' ? new Date(startDay.getTime() + value * DAY_MS) : addMonthsClamped(startDay, unit === 'YEARS' ? value * 12 : value);
  return endOfLocalDay(lastDay, timeZone);
}

/** Vigência na data/km dados: o que ocorrer primeiro (prazo ou km) encerra a garantia. */
export function evaluateWarranty(
  w: { validUntil: Date; kmUntil: number | Prisma.Decimal | null },
  at: Date,
  km?: number | null
): { active: boolean; expiredBy: WarrantyExpiredBy } {
  if (at.getTime() > new Date(w.validUntil).getTime()) return { active: false, expiredBy: 'DATE' };
  if (w.kmUntil !== null && w.kmUntil !== undefined && km !== null && km !== undefined && km >= Number(w.kmUntil)) {
    return { active: false, expiredBy: 'KM' };
  }
  return { active: true, expiredBy: null };
}

type ClosingOs = {
  id: string;
  companyId: string;
  branchId: string;
  customerId: string;
  motorcycleId: string;
  entryKilometer: Prisma.Decimal | number;
  exitKilometer: Prisma.Decimal | number | null;
  deliveryDate: Date | null;
};

export interface PreparedCloseDecision {
  decision: 'NONE' | 'GRANTED' | null;
  /** km de saída a gravar na OS (quando informado no encerramento e ainda vazio). */
  exitKilometer?: number;
  warranty?: Omit<Prisma.ServiceOrderWarrantyUncheckedCreateInput, 'createdBy'>;
}

const WARRANTY_INCLUDE = {
  claims: { orderBy: { createdAt: 'desc' as const } },
  serviceOrder: {
    select: {
      id: true,
      osNumber: true,
      branchId: true,
      deliveryDate: true,
      customer: { select: { id: true, name: true, phone: true, whatsapp: true } },
      motorcycle: { select: { id: true, brand: true, model: true, licensePlate: true, kilometerReading: true } },
    },
  },
} satisfies Prisma.ServiceOrderWarrantyInclude;

type WarrantyWithOs = Prisma.ServiceOrderWarrantyGetPayload<{ include: typeof WARRANTY_INCLUDE }>;

function withStatus(w: WarrantyWithOs, now: Date, km?: number | null) {
  const knownKm = km ?? (w.serviceOrder?.motorcycle?.kilometerReading != null ? Number(w.serviceOrder.motorcycle.kilometerReading) : null);
  const evaluation = evaluateWarranty(w, now, knownKm);
  return {
    ...w,
    status: evaluation.active ? ('ACTIVE' as const) : ('EXPIRED' as const),
    expiredBy: evaluation.expiredBy,
    evaluatedKm: knownKm,
    durationLabel: durationLabel(w.durationValue, w.durationUnit as WarrantyDurationUnit),
  };
}

const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  OPEN: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['RESOLVED'],
  REJECTED: [],
  RESOLVED: [],
};
const CLAIM_LABEL: Record<ClaimStatus, string> = { OPEN: 'aberta', ACCEPTED: 'aceita', REJECTED: 'recusada', RESOLVED: 'resolvida' };

export class WarrantyService {
  /**
   * Antes da transação do encerramento: lê a política da filial da OS e valida/monta a garantia. Nada é gravado aqui.
   * Os itens da OS não mudam mais neste ponto (ENCERRADA exige pagamento e `addItem` recusa OS paga).
   */
  async prepareCloseDecision(os: ClosingOs, input: WarrantyDecisionInput | undefined, now = new Date()): Promise<PreparedCloseDecision> {
    const policies = await policyService.effective(os.companyId, os.branchId);
    const enabled = policies['warranty.enabled'];
    const requireDecision = policies['warranty.requireDecisionOnClose'];

    if (!input) {
      if (enabled && requireDecision) {
        throw new AppError(
          'Informe a decisão de garantia para encerrar a OS: "sem garantia" ou os dados da garantia (tipo, prazo e, se houver, km).',
          400,
          'WARRANTY_DECISION_REQUIRED'
        );
      }
      return { decision: null };
    }
    if (input.decision === 'NONE') return { decision: 'NONE' };

    if (!enabled) {
      throw new ConflictError('A garantia de OS está desabilitada na política desta empresa/filial. Encerre como "sem garantia".', 'WARRANTY_DISABLED');
    }

    const entryKm = Number(os.entryKilometer);
    const startKm = input.startKm ?? (os.exitKilometer != null ? Number(os.exitKilometer) : entryKm);
    if (startKm < entryKm) {
      throw new AppError(`O km inicial da garantia (${formatKm(startKm)}) não pode ser menor que o km de entrada da OS (${formatKm(entryKm)}).`, 400, 'INVALID_START_KM');
    }

    const items = await prisma.serviceOrderItem.findMany({
      where: { serviceOrderId: os.id },
      select: { id: true, itemType: true, description: true, quantity: true, productId: true },
    });
    const typesCovered = input.coverage === 'SERVICE' ? ['SERVICE'] : input.coverage === 'PART' ? ['PART'] : ['SERVICE', 'PART'];
    let covered = items.filter((i) => typesCovered.includes(i.itemType));
    if (input.coveredItemIds && input.coveredItemIds.length > 0) {
      const wanted = new Set(input.coveredItemIds);
      const unknown = [...wanted].filter((id) => !items.some((i) => i.id === id));
      if (unknown.length > 0) throw new AppError('Item coberto não pertence a esta OS.', 400, 'WARRANTY_ITEM_NOT_IN_OS');
      const wrongType = items.filter((i) => wanted.has(i.id) && !typesCovered.includes(i.itemType));
      if (wrongType.length > 0) {
        throw new AppError(
          `"${wrongType[0].description}" é ${wrongType[0].itemType === 'PART' ? 'peça' : 'serviço'} e não entra no tipo de garantia escolhido.`,
          400,
          'WARRANTY_ITEM_TYPE_MISMATCH'
        );
      }
      covered = items.filter((i) => wanted.has(i.id));
    }
    if (covered.length === 0) {
      throw new AppError(
        input.coverage === 'SERVICE'
          ? 'A OS não tem serviço para cobrir com garantia de serviço.'
          : input.coverage === 'PART'
            ? 'A OS não tem peça para cobrir com garantia de peça.'
            : 'A OS não tem itens para cobrir com garantia.',
        400,
        'WARRANTY_NO_COVERED_ITEMS'
      );
    }

    const startDate = os.deliveryDate ?? now;
    const timeZone = policies['company.timezone'];
    const validUntil = computeValidUntil(startDate, input.durationValue, input.durationUnit, timeZone);
    const kmLimit = input.kmLimit ?? null;

    return {
      decision: 'GRANTED',
      ...(input.startKm != null && os.exitKilometer == null ? { exitKilometer: input.startKm } : {}),
      warranty: {
        companyId: os.companyId,
        branchId: os.branchId,
        serviceOrderId: os.id,
        customerId: os.customerId,
        motorcycleId: os.motorcycleId,
        coverage: input.coverage,
        durationValue: input.durationValue,
        durationUnit: input.durationUnit,
        kmLimit,
        startDate,
        validUntil,
        startKm,
        kmUntil: kmLimit !== null ? startKm + kmLimit : null,
        coveredItems: covered.map((i) => ({
          id: i.id,
          itemType: i.itemType,
          description: i.description,
          quantity: Number(i.quantity),
          productId: i.productId,
        })) as Prisma.InputJsonValue,
        conditions: input.conditions ?? null,
        notes: input.notes ?? null,
      },
    };
  }

  /** Dentro da transação do encerramento: grava a garantia (uma por OS — unique em serviceOrderId). */
  async createInTx(tx: Prisma.TransactionClient, prepared: PreparedCloseDecision, createdBy: string) {
    if (!prepared.warranty) return null;
    try {
      return await tx.serviceOrderWarranty.create({ data: { ...prepared.warranty, createdBy } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictError('Esta OS já tem garantia registrada.', 'WARRANTY_ALREADY_EXISTS');
      }
      throw e;
    }
  }

  async list(filters: {
    companyId: string;
    customerId?: string;
    motorcycleId?: string;
    serviceOrderId?: string;
    status?: 'ACTIVE' | 'EXPIRED';
    km?: number;
    limit?: number;
    now?: Date;
  }) {
    const now = filters.now ?? new Date();
    const limit = filters.limit ?? 50;
    const rows = await prisma.serviceOrderWarranty.findMany({
      where: {
        companyId: filters.companyId,
        ...(filters.customerId && { customerId: filters.customerId }),
        ...(filters.motorcycleId && { motorcycleId: filters.motorcycleId }),
        ...(filters.serviceOrderId && { serviceOrderId: filters.serviceOrderId }),
        // Vigente exige prazo em dia (o km é conferido depois, com o km conhecido do veículo).
        ...(filters.status === 'ACTIVE' && { validUntil: { gte: now } }),
      },
      include: WARRANTY_INCLUDE,
      orderBy: [{ validUntil: 'desc' }],
      take: 500,
    });
    const evaluated = rows.map((w) => withStatus(w, now, filters.km));
    const filtered = filters.status ? evaluated.filter((w) => w.status === filters.status) : evaluated;
    return { warranties: filtered.slice(0, limit), total: filtered.length };
  }

  async getById(id: string, companyId: string, km?: number) {
    const w = await prisma.serviceOrderWarranty.findFirst({ where: { id, companyId }, include: WARRANTY_INCLUDE });
    if (!w) throw new AppError('Garantia não encontrada', 404, 'WARRANTY_NOT_FOUND');
    return withStatus(w, new Date(), km);
  }

  /** Ocorrência de garantia: só dentro da vigência na data e no km informados. */
  async openClaim(input: { companyId: string; warrantyId: string; description: string; kmAtClaim?: number | null; userId: string; now?: Date }) {
    const now = input.now ?? new Date();
    const w = await prisma.serviceOrderWarranty.findFirst({
      where: { id: input.warrantyId, companyId: input.companyId },
      include: { serviceOrder: { select: { osNumber: true } } },
    });
    if (!w) throw new AppError('Garantia não encontrada', 404, 'WARRANTY_NOT_FOUND');

    const km = input.kmAtClaim ?? null;
    if (w.kmUntil !== null && km === null) {
      throw new AppError(
        `Informe a quilometragem atual do veículo: esta garantia vale até ${formatKm(Number(w.kmUntil))} km.`,
        400,
        'WARRANTY_KM_REQUIRED'
      );
    }
    if (km !== null && w.startKm !== null && km < Number(w.startKm)) {
      throw new AppError(
        `A quilometragem informada (${formatKm(km)} km) é menor que a do início da garantia (${formatKm(Number(w.startKm))} km).`,
        400,
        'INVALID_KM'
      );
    }
    const evaluation = evaluateWarranty(w, now, km);
    if (!evaluation.active) {
      const until = new Intl.DateTimeFormat('pt-BR', { timeZone: await policyService.get(w.companyId, w.branchId, 'company.timezone') }).format(w.validUntil);
      throw new ConflictError(
        evaluation.expiredBy === 'DATE'
          ? `Garantia da OS #${w.serviceOrder.osNumber} fora da vigência: o prazo terminou em ${until}.`
          : `Garantia da OS #${w.serviceOrder.osNumber} fora da vigência: o limite de ${formatKm(Number(w.kmUntil))} km foi atingido (informado: ${formatKm(km as number)} km).`,
        'WARRANTY_EXPIRED'
      );
    }

    return runInTransaction(async (tx) => {
      const claim = await tx.warrantyClaim.create({
        data: {
          companyId: w.companyId,
          branchId: w.branchId,
          warrantyId: w.id,
          serviceOrderId: w.serviceOrderId,
          description: input.description,
          kmAtClaim: km,
          status: 'OPEN',
          openedBy: input.userId,
        },
      });
      // Leitura real do odômetro: só avança (mesma regra da revisão).
      if (km !== null) {
        await tx.motorcycle.updateMany({ where: { id: w.motorcycleId, kilometerReading: { lt: km } }, data: { kilometerReading: km } });
      }
      return claim;
    });
  }

  /** Decisão da ocorrência (gerência+): OPEN → ACCEPTED|REJECTED; ACCEPTED → RESOLVED. */
  async decideClaim(input: {
    companyId: string;
    claimId: string;
    status: 'ACCEPTED' | 'REJECTED' | 'RESOLVED';
    decisionNotes: string;
    newServiceOrderId?: string | null;
    userId: string;
  }) {
    const claim = await prisma.warrantyClaim.findFirst({
      where: { id: input.claimId, companyId: input.companyId },
      include: { warranty: { select: { motorcycleId: true, serviceOrderId: true } } },
    });
    if (!claim) throw new AppError('Ocorrência de garantia não encontrada', 404, 'WARRANTY_CLAIM_NOT_FOUND');

    const from = claim.status as ClaimStatus;
    if (!(CLAIM_TRANSITIONS[from] ?? []).includes(input.status)) {
      throw new ConflictError(
        `A ocorrência está ${CLAIM_LABEL[from] ?? from} e não pode ser ${CLAIM_LABEL[input.status as ClaimStatus]}${from === 'OPEN' && input.status === 'RESOLVED' ? ' antes de ser aceita' : ''}.`,
        'WARRANTY_CLAIM_INVALID_TRANSITION'
      );
    }

    if (input.newServiceOrderId) {
      if (input.status === 'REJECTED') {
        throw new AppError('Ocorrência recusada não tem OS de retorno.', 400, 'WARRANTY_CLAIM_RETURN_OS_ON_REJECT');
      }
      const ret = await prisma.serviceOrder.findFirst({
        where: { id: input.newServiceOrderId, companyId: input.companyId },
        select: { id: true, motorcycleId: true },
      });
      if (!ret) throw new AppError('OS de retorno não encontrada nesta empresa', 404, 'RETURN_SERVICE_ORDER_NOT_FOUND');
      if (ret.id === claim.warranty.serviceOrderId) {
        throw new AppError('A OS de retorno precisa ser outra OS, não a OS original da garantia.', 400, 'RETURN_SERVICE_ORDER_IS_ORIGINAL');
      }
      if (ret.motorcycleId !== claim.warranty.motorcycleId) {
        throw new AppError('A OS de retorno precisa ser do mesmo veículo da garantia.', 400, 'RETURN_SERVICE_ORDER_MISMATCH');
      }
    }

    return runInTransaction(async (tx) => {
      const claimed = await tx.warrantyClaim.updateMany({
        where: { id: claim.id, companyId: input.companyId, status: from },
        data: {
          status: input.status,
          decisionNotes: input.decisionNotes,
          decidedBy: input.userId,
          decidedAt: new Date(),
          ...(input.newServiceOrderId ? { newServiceOrderId: input.newServiceOrderId } : {}),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictError('A ocorrência foi alterada por outra pessoa agora mesmo. Atualize e tente de novo.', 'WARRANTY_CLAIM_CHANGED');
      }
      return tx.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    });
  }
}

export const warrantyService = new WarrantyService();
export default warrantyService;
