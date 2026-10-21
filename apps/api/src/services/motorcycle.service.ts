import { prisma } from '@ln-system/database';
import { Prisma } from '@prisma/client';

export class MotorcycleService {
  async create(data: {
    companyId: string;
    customerId: string;
    vehicleType?: 'MOTORCYCLE' | 'CAR';
    licensePlate?: string;
    chassisNumber?: string;
    brand: string;
    model: string;
    year?: number;
    color?: string;
    engineNumber?: string;
    kilometerReading: number;
  }) {
    // O cliente precisa pertencer à mesma empresa — sem isso seria possível
    // vincular uma motocicleta a um cliente de outra empresa.
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, companyId: data.companyId },
      select: { id: true },
    });
    if (!customer) {
      throw new Error('Customer not found');
    }

    return await prisma.motorcycle.create({
      data: {
        companyId: data.companyId,
        customerId: data.customerId,
        vehicleType: data.vehicleType,
        licensePlate: data.licensePlate,
        chassisNumber: data.chassisNumber,
        brand: data.brand,
        model: data.model,
        year: data.year,
        color: data.color,
        engineNumber: data.engineNumber,
        kilometerReading: data.kilometerReading,
      },
    });
  }

  async list(filters: {
    companyId: string;
    customerId?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const { companyId, customerId, search, page = 1, limit = 20 } = filters;

    const where: Prisma.MotorcycleWhereInput = {
      companyId,
      isActive: true,
      ...(customerId && { customerId }),
      ...(search && {
        OR: [
          { licensePlate: { contains: search, mode: 'insensitive' } },
          { chassisNumber: { contains: search, mode: 'insensitive' } },
          { brand: { contains: search, mode: 'insensitive' } },
          { model: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [motorcycles, total] = await Promise.all([
      prisma.motorcycle.findMany({
        where,
        include: { customer: { select: { id: true, name: true, phone: true } } },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.motorcycle.count({ where }),
    ]);

    return { motorcycles, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getById(id: string, companyId: string) {
    return await prisma.motorcycle.findFirst({
      where: { id, companyId },
      include: {
        customer: true,
        serviceOrders: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
  }

  async update(id: string, companyId: string, data: Prisma.MotorcycleUpdateInput) {
    const existing = await prisma.motorcycle.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!existing) {
      throw new Error('Motorcycle not found');
    }

    return await prisma.motorcycle.update({ where: { id }, data });
  }

  async deactivate(id: string, companyId: string) {
    const existing = await prisma.motorcycle.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!existing) {
      throw new Error('Motorcycle not found');
    }

    return await prisma.motorcycle.update({ where: { id }, data: { isActive: false } });
  }
}

export default new MotorcycleService();
