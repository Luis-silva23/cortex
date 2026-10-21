import { prisma, runInTransaction } from '@ln-system/database';

/**
 * Soma meses mantendo o dia, limitado ao último dia do mês de destino: 31/01 + 1 mês = 28/02 (ou 29/02). Com
 * `setMonth` puro a data "transbordava" (31/01 + 1 mês = 03/03) e a próxima revisão saía dias depois do combinado.
 */
export function addMonthsClamped(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export class RevisionService {
  // Imutável por design (ver comentário no schema.prisma): nunca existe
  // update/delete aqui, só create + leitura. nextDueDate/nextDueKilometer
  // são calculados aqui e persistidos — não recalculados na leitura — para
  // que o histórico continue refletindo o que foi comunicado ao cliente na
  // época, mesmo se a política de intervalo padrão mudar depois.
  async create(data: {
    companyId: string;
    branchId?: string;
    customerId: string;
    motorcycleId: string;
    serviceOrderId?: string;
    performedAt: Date;
    kilometerAtService: number;
    servicesPerformed: string;
    partsReplaced?: string;
    /** recomendação ao cliente (o que fazer/observar até a próxima revisão) */
    recommendations?: string;
    notes?: string;
    intervalMonths: number;
    intervalKilometers?: number;
    recordedBy: string;
  }) {
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, companyId: data.companyId },
      select: { id: true },
    });
    if (!customer) {
      throw new Error('Customer not found');
    }

    const motorcycle = await prisma.motorcycle.findFirst({
      where: { id: data.motorcycleId, companyId: data.companyId, customerId: data.customerId },
      select: { id: true },
    });
    if (!motorcycle) {
      throw new Error('Motorcycle not found for this customer');
    }

    if (data.serviceOrderId) {
      const serviceOrder = await prisma.serviceOrder.findFirst({
        where: { id: data.serviceOrderId, companyId: data.companyId },
        select: { id: true, customerId: true, motorcycleId: true },
      });
      if (!serviceOrder) {
        throw new Error('Service order not found');
      }
      // ACHADO DE AUDITORIA DE INTEGRAÇÃO: a checagem anterior só validava
      // que a OS existia na empresa — não que era a OS do MESMO
      // cliente/moto informados para a revisão. Sem isso, uma revisão podia
      // referenciar uma OS de outro veículo, corrompendo o histórico (e o
      // cálculo de próxima revisão) do veículo errado.
      if (serviceOrder.customerId !== data.customerId || serviceOrder.motorcycleId !== data.motorcycleId) {
        throw new Error('Service order does not belong to the given customer/motorcycle');
      }
    }

    const nextDueDate = addMonthsClamped(data.performedAt, data.intervalMonths);

    const nextDueKilometer = data.intervalKilometers
      ? data.kilometerAtService + data.intervalKilometers
      : null;

    // ACHADO DE AUDITORIA DE INTEGRAÇÃO: Motorcycle.kilometerReading só era
    // gravado na criação do veículo e nunca mais atualizado — a revisão é o
    // único evento do sistema que registra uma leitura real e confiável do
    // odômetro depois disso, então é o ponto certo para sincronizar. Só
    // avança (nunca reduz): revisões podem ser lançadas fora de ordem, e uma
    // leitura antiga não deve sobrescrever uma mais recente já registrada.
    return runInTransaction(async (tx) => {
      await tx.motorcycle.updateMany({
        where: { id: data.motorcycleId, kilometerReading: { lt: data.kilometerAtService } },
        data: { kilometerReading: data.kilometerAtService },
      });

      return tx.revision.create({
        data: {
          companyId: data.companyId,
          branchId: data.branchId,
          customerId: data.customerId,
          motorcycleId: data.motorcycleId,
          serviceOrderId: data.serviceOrderId,
          performedAt: data.performedAt,
          kilometerAtService: data.kilometerAtService,
          servicesPerformed: data.servicesPerformed,
          partsReplaced: data.partsReplaced,
          recommendations: data.recommendations,
          notes: data.notes,
          intervalMonths: data.intervalMonths,
          intervalKilometers: data.intervalKilometers,
          nextDueDate,
          nextDueKilometer,
          recordedBy: data.recordedBy,
        },
        include: { customer: true, motorcycle: true },
      });
    });
  }

  async getById(id: string, companyId: string) {
    return prisma.revision.findFirst({
      where: { id, companyId },
      include: { customer: true, motorcycle: true, followUps: true },
    });
  }

  async list(filters: {
    companyId: string;
    branchId?: string;
    customerId?: string;
    motorcycleId?: string;
    dueBefore?: Date;
    page: number;
    limit: number;
  }) {
    const where: any = { companyId: filters.companyId };
    if (filters.branchId) where.branchId = filters.branchId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.motorcycleId) where.motorcycleId = filters.motorcycleId;
    if (filters.dueBefore) where.nextDueDate = { lte: filters.dueBefore };

    const [revisions, total] = await Promise.all([
      prisma.revision.findMany({
        where,
        include: { customer: true, motorcycle: true },
        orderBy: { nextDueDate: 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.revision.count({ where }),
    ]);

    return { revisions, pagination: { page: filters.page, limit: filters.limit, total, pages: Math.ceil(total / filters.limit) } };
  }
}

export default new RevisionService();
