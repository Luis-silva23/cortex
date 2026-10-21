import { prisma, License } from '@ln-system/database';
import type { CreateLicenseRequest, ApproveLicenseRequest } from '@ln-system/shared/types';
import { ConflictError } from '@ln-system/shared';

export class LicenseService {
  /**
   * Listar todas as licenças (Super Admin)
   */
  async findAll(): Promise<License[]> {
    return prisma.license.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            document: true,
          },
        },
        _count: {
          select: {
            devices: true,
            activations: true,
          },
        },
      },
    });
  }

  /**
   * Listar licenças por empresa
   */
  async findByCompany(companyId: string): Promise<License[]> {
    return prisma.license.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            devices: true,
            activations: true,
          },
        },
      },
    });
  }

  /**
   * Buscar licença por ID
   */
  async findById(id: string): Promise<License | null> {
    return prisma.license.findUnique({
      where: { id },
      include: {
        company: true,
        devices: true,
      },
    });
  }

  /**
   * Criar licença
   */
  async create(data: CreateLicenseRequest): Promise<License> {
    const canCreate = await this.canCreateLicense(data.companyId);
    if (!canCreate) {
      throw new ConflictError(
        'Esta empresa já possui uma licença ativa ou aguardando aprovação. Cancele ou suspenda a existente antes de criar outra.'
      );
    }
    return prisma.license.create({
      data: {
        companyId: data.companyId,
        licenseType: data.licenseType,
        status: 'PENDING_APPROVAL',
        maxDevices: data.maxDevices,
        maxUsers: data.maxUsers,
        maxBranches: data.maxBranches,
        notes: data.notes,
      },
    });
  }

  /**
   * Aprovar licença (Super Admin)
   */
  async approve(
    id: string,
    data: ApproveLicenseRequest,
    approvedBy: string
  ): Promise<License> {
    return prisma.license.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        startDate: data.startDate,
        expiryDate: data.expiryDate,
        approvedBy,
        approvedAt: new Date(),
        notes: data.notes,
      },
    });
  }

  /**
   * Suspender licença
   */
  async suspend(id: string): Promise<License> {
    return prisma.license.update({
      where: { id },
      data: { status: 'SUSPENDED' },
    });
  }

  /**
   * Reativar licença
   */
  async reactivate(id: string): Promise<License> {
    return prisma.license.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
  }

  /**
   * Cancelar licença
   */
  async cancel(id: string): Promise<License> {
    return prisma.license.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  /**
   * Verificar se empresa pode criar mais licenças
   */
  async canCreateLicense(companyId: string): Promise<boolean> {
    const activeLicenses = await prisma.license.count({
      where: {
        companyId,
        status: {
          in: ['ACTIVE', 'PENDING_APPROVAL'],
        },
      },
    });

    // Limite de 1 licença ativa por empresa (pode ser configurável)
    return activeLicenses === 0;
  }
}
