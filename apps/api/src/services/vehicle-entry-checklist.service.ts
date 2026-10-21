import { prisma } from '@ln-system/database';
import { Prisma } from '@prisma/client';

export class VehicleEntryChecklistService {
  /**
   * Registro de vistoria de entrada da moto na OS — reduz disputa futura
   * sobre avaria pré-existente. Item marcado DAMAGED sem descrição não
   * ajuda em nada numa disputa ("estava riscado" riscado onde? como?), por
   * isso a descrição é obrigatória nesse caso, validada aqui (a coluna no
   * banco é opcional porque só é obrigatória condicionalmente).
   */
  async create(data: {
    serviceOrderId: string;
    companyId: string;
    motorcycleId: string;
    checkedBy: string;
    items: Array<{
      itemName: string;
      status: 'OK' | 'DAMAGED' | 'NOT_CHECKED';
      description?: string;
      photoUrl?: string;
    }>;
  }) {
    const serviceOrder = await prisma.serviceOrder.findFirst({
      where: { id: data.serviceOrderId, companyId: data.companyId },
    });
    if (!serviceOrder) {
      throw new Error('Service order not found');
    }

    // Nunca confiar no motorcycleId enviado pelo chamador — precisa bater
    // com a moto de fato vinculada à OS, senão a vistoria fica registrada
    // contra o veículo errado.
    if (serviceOrder.motorcycleId !== data.motorcycleId) {
      throw new Error('Motorcycle does not match the motorcycle linked to this service order');
    }

    // Pré-checagem: dá um erro de negócio claro no caminho feliz. A
    // garantia real é o índice único em `serviceOrderId` no banco — uma
    // corrida entre duas requisições concorrentes para a mesma OS passa
    // por aqui sem ver a outra ainda, e a segunda esbarra no P2002 do
    // create() abaixo (mesmo padrão usado em cash-register/device-session
    // nesta base).
    const existing = await prisma.vehicleEntryChecklist.findUnique({
      where: { serviceOrderId: data.serviceOrderId },
      select: { id: true },
    });
    if (existing) {
      throw new Error('A checklist de entrada já foi registrada para esta OS');
    }

    for (const item of data.items) {
      if (item.status === 'DAMAGED' && !item.description?.trim()) {
        throw new Error(`Item "${item.itemName}" marcado como DAMAGED precisa de uma descrição`);
      }
    }

    try {
      return await prisma.vehicleEntryChecklist.create({
        data: {
          companyId: data.companyId,
          serviceOrderId: data.serviceOrderId,
          motorcycleId: data.motorcycleId,
          checkedBy: data.checkedBy,
          items: {
            create: data.items.map((item) => ({
              itemName: item.itemName,
              status: item.status,
              description: item.description,
              photoUrl: item.photoUrl,
            })),
          },
        },
        include: { items: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new Error('A checklist de entrada já foi registrada para esta OS');
      }
      throw error;
    }
  }

  /**
   * Nunca confia só na RLS — filtra explicitamente por companyId aqui
   * também (via a OS), mesma convenção usada no resto do serviço de OS.
   * Ausência de checklist não é erro: muitas OS's simplesmente ainda não
   * tiveram a vistoria de entrada registrada.
   */
  async getByServiceOrderId(serviceOrderId: string, companyId: string) {
    const serviceOrder = await prisma.serviceOrder.findFirst({
      where: { id: serviceOrderId, companyId },
      select: { id: true },
    });
    if (!serviceOrder) {
      throw new Error('Service order not found');
    }

    return await prisma.vehicleEntryChecklist.findUnique({
      where: { serviceOrderId },
      include: { items: true },
    });
  }
}

export default new VehicleEntryChecklistService();
