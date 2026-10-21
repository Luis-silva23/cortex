import { prisma } from '@ln-system/database';
import { Prisma } from '@prisma/client';

export class SupplierService {
  async create(data: {
    companyId: string;
    name: string;
    tradeName?: string;
    document: string;
    email?: string;
    phone?: string;
    mobile?: string;
    address?: string;
    addressNumber?: string;
    addressComplement?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    notes?: string;
  }) {
    const existing = await prisma.supplier.findFirst({
      where: { companyId: data.companyId, document: data.document },
      select: { id: true },
    });
    if (existing) {
      throw new Error('A supplier with this document already exists for this company');
    }

    return await prisma.supplier.create({ data });
  }

  async list(filters: { companyId: string; search?: string; isActive?: boolean; page?: number; limit?: number }) {
    const { companyId, search, isActive, page = 1, limit = 20 } = filters;

    const where: Prisma.SupplierWhereInput = {
      companyId,
      ...(isActive !== undefined && { isActive }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { document: { contains: search } },
        ],
      }),
    };

    const [suppliers, total] = await Promise.all([
      prisma.supplier.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { name: 'asc' } }),
      prisma.supplier.count({ where }),
    ]);

    return { suppliers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getById(id: string, companyId: string) {
    return await prisma.supplier.findFirst({
      where: { id, companyId },
      include: { purchaseOrders: { orderBy: { orderDate: 'desc' }, take: 10 } },
    });
  }

  async update(id: string, companyId: string, data: Prisma.SupplierUpdateInput) {
    const existing = await prisma.supplier.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!existing) {
      throw new Error('Supplier not found');
    }
    return await prisma.supplier.update({ where: { id }, data });
  }

  async deactivate(id: string, companyId: string) {
    const existing = await prisma.supplier.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!existing) {
      throw new Error('Supplier not found');
    }
    return await prisma.supplier.update({ where: { id }, data: { isActive: false } });
  }
}

export default new SupplierService();
