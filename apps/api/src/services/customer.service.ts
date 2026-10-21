import { prisma, runInTransaction } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import { AppError, ConflictError } from '@ln-system/shared';
import { isValidDocument } from '@ln-system/shared/utils/validation';

/**
 * Cadastro de cliente (docs/CORTEX/policies/CLIENTE.md, 2026-09-27).
 *
 * - CPF/CNPJ informado precisa ter dígito verificador válido (a importação já validava; o cadastro manual não).
 *   Documento vazio continua permitido (balcão sem identificação).
 * - Duplicidade é por DÍGITOS: "123.456.789-09" e "12345678909" são o mesmo cliente (antes a unique
 *   [companyId, document] comparava o texto e deixava os dois entrarem).
 * - Documento novo/alterado é gravado no formato padrão (000.000.000-00 / 00.000.000/0000-00). Documento que não mudou
 *   (mesmos dígitos) fica exatamente como está gravado — nenhum dado existente é reescrito ou migrado.
 * - Contato preferencial precisa ser coerente com os contatos preenchidos (WhatsApp ⇒ WhatsApp; e-mail ⇒ e-mail;
 *   telefone/SMS ⇒ telefone ou celular).
 */

const onlyDigits = (v: string) => v.replace(/\D/g, '');

export function formatDocument(doc: string): string {
  const d = onlyDigits(doc);
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return doc.trim();
}

/** Formas usuais do mesmo documento (texto digitado, só dígitos e máscara padrão) — para a busca. */
export function documentVariants(doc: string): string[] {
  return [...new Set([doc.trim(), onlyDigits(doc), formatDocument(doc)].filter(Boolean))];
}

type ContactFields = {
  preferredContact?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
};

export function assertPreferredContactCoherent(c: ContactFields): void {
  const fail = (message: string) => {
    throw new AppError(message, 400, 'PREFERRED_CONTACT_INCOHERENT');
  };
  switch (c.preferredContact) {
    case 'WHATSAPP':
      if (!c.whatsapp) fail('Contato preferencial é WhatsApp: informe o número de WhatsApp do cliente.');
      break;
    case 'EMAIL':
      if (!c.email) fail('Contato preferencial é e-mail: informe o e-mail do cliente.');
      break;
    case 'PHONE':
      if (!c.phone && !c.mobile) fail('Contato preferencial é telefone: informe o telefone do cliente.');
      break;
    case 'SMS':
      if (!c.phone && !c.mobile) fail('Contato preferencial é SMS: informe o celular do cliente.');
      break;
    default:
      break;
  }
}

function assertValidDocument(doc: string): void {
  if (!isValidDocument(doc)) {
    throw new AppError('CPF/CNPJ inválido: confira os dígitos (CPF tem 11 e CNPJ tem 14).', 400, 'INVALID_DOCUMENT');
  }
}

function duplicateError(name?: string) {
  return new ConflictError(
    name ? `Já existe cliente com este CPF/CNPJ nesta empresa: ${name}.` : 'Já existe cliente com este CPF/CNPJ nesta empresa.',
    'CUSTOMER_DOCUMENT_DUPLICATE'
  );
}

/** Outro cliente da empresa com os mesmos dígitos de documento (qualquer formatação gravada). */
async function findByDocumentDigits(companyId: string, doc: string, exceptId?: string): Promise<{ id: string; name: string } | null> {
  const digits = onlyDigits(doc);
  if (!digits) return null;
  const rows = await runInTransaction((tx) =>
    tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM customers
      WHERE "companyId" = ${companyId}
        AND document IS NOT NULL
        AND regexp_replace(document, ${'[^0-9]'}, '', 'g') = ${digits}
        ${exceptId ? Prisma.sql`AND id <> ${exceptId}` : Prisma.empty}
      LIMIT 1`
  );
  return rows[0] ?? null;
}

function isUniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export class CustomerService {
  // Criar cliente
  async createCustomer(data: Prisma.CustomerUncheckedCreateInput) {
    const input = { ...data };
    if (input.document) {
      assertValidDocument(input.document);
      const existing = await findByDocumentDigits(input.companyId, input.document);
      if (existing) throw duplicateError(existing.name);
      input.document = formatDocument(input.document);
      // Sem tipo informado (cadastro rápido do PDV), CNPJ indica pessoa jurídica.
      if (!input.customerType && onlyDigits(input.document).length === 14) input.customerType = 'BUSINESS';
    }
    assertPreferredContactCoherent(input);
    try {
      return await prisma.customer.create({ data: input });
    } catch (e) {
      if (isUniqueViolation(e)) throw duplicateError();
      throw e;
    }
  }

  // Listar clientes
  async listCustomers(filters: {
    companyId: string;
    search?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }) {
    const { companyId, search, isActive, page = 1, limit = 20 } = filters;

    const where: Prisma.CustomerWhereInput = {
      companyId,
      ...(isActive !== undefined && { isActive }),
      ...(search && { OR: searchConditions(search, true) }),
    };

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { name: 'asc' },
      }),
      prisma.customer.count({ where }),
    ]);

    return {
      customers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Buscar cliente por ID
  async getCustomerById(id: string, companyId: string) {
    return await prisma.customer.findFirst({
      where: { id, companyId },
      include: {
        sales: {
          orderBy: { saleDate: 'desc' },
          take: 10, // Últimas 10 vendas
        },
      },
    });
  }

  // Buscar cliente por documento (qualquer formatação: compara os dígitos)
  async findByDocument(companyId: string, document: string) {
    const found = await findByDocumentDigits(companyId, document);
    return found ? prisma.customer.findFirst({ where: { id: found.id, companyId } }) : null;
  }

  // Atualizar cliente
  async updateCustomer(id: string, companyId: string, data: Prisma.CustomerUncheckedUpdateInput) {
    // Confirma que o cliente pertence à empresa do requisitante ANTES de
    // escrever — mesma correção de IDOR aplicada em product.service.ts.
    const existing = await prisma.customer.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new Error('Customer not found');
    }

    const input = { ...data };
    if (typeof input.document === 'string') {
      const sameDigits = existing.document && onlyDigits(existing.document) === onlyDigits(input.document);
      if (sameDigits) {
        // Mesmo documento (só mudou a máscara, ou o formulário reenviou o valor): mantém o que está gravado — inclusive
        // documento legado sem dígito válido, que não deve impedir editar o resto do cadastro.
        delete input.document;
      } else {
        assertValidDocument(input.document);
        const other = await findByDocumentDigits(companyId, input.document, id);
        if (other) throw duplicateError(other.name);
        input.document = formatDocument(input.document);
      }
    }

    const pick = <K extends keyof ContactFields>(k: K) =>
      (input[k] !== undefined ? (input[k] as string | null) : (existing[k] as string | null)) ?? null;
    assertPreferredContactCoherent({
      preferredContact: pick('preferredContact'),
      whatsapp: pick('whatsapp'),
      email: pick('email'),
      phone: pick('phone'),
      mobile: pick('mobile'),
    });

    try {
      return await prisma.customer.update({ where: { id }, data: input });
    } catch (e) {
      if (isUniqueViolation(e)) throw duplicateError();
      throw e;
    }
  }

  // Soft delete (desativar)
  async deleteCustomer(id: string, companyId: string) {
    const existing = await prisma.customer.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existing) {
      throw new Error('Customer not found');
    }

    return await prisma.customer.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // Busca rápida (para PDV)
  async searchCustomers(companyId: string, search: string, limit = 10) {
    return await prisma.customer.findMany({
      where: {
        companyId,
        isActive: true,
        OR: searchConditions(search, false),
      },
      take: limit,
      orderBy: { name: 'asc' },
    });
  }

  // Estatísticas do cliente
  async getCustomerStats(id: string, companyId: string) {
    const customer = await prisma.customer.findFirst({
      where: { id, companyId },
    });

    if (!customer) {
      throw new Error('Customer not found');
    }

    // Agregado no banco (antes: todas as vendas do cliente, linhas inteiras, para somar em memória). A "última compra"
    // vinha de sales[0] sem ordenação — uma venda qualquer, não a mais recente.
    const where = { customerId: id, companyId, status: { in: ['PAID' as const, 'PARTIALLY_PAID' as const] } };
    const agg = await prisma.sale.aggregate({ where, _sum: { totalAmount: true }, _count: true, _max: { saleDate: true } });

    const totalSales = agg._count;
    const totalPurchases = Number(agg._sum.totalAmount ?? 0);
    const avgTicket = totalSales > 0 ? totalPurchases / totalSales : 0;

    return {
      customer,
      stats: {
        totalPurchases,
        totalSales,
        avgTicket,
        lastPurchase: agg._max.saleDate ?? null,
      },
    };
  }
}

/** Nome, documento (qualquer máscara quando o termo é um CPF/CNPJ completo), telefones, WhatsApp e (lista) e-mail. */
function searchConditions(search: string, includeEmail: boolean): Prisma.CustomerWhereInput[] {
  const or: Prisma.CustomerWhereInput[] = [
    { name: { contains: search, mode: 'insensitive' } },
    { document: { contains: search, mode: 'insensitive' } },
    { phone: { contains: search, mode: 'insensitive' } },
    { mobile: { contains: search, mode: 'insensitive' } },
    { whatsapp: { contains: search, mode: 'insensitive' } },
  ];
  if (includeEmail) or.push({ email: { contains: search, mode: 'insensitive' } });
  const digits = onlyDigits(search);
  if (digits.length === 11 || digits.length === 14) or.push({ document: { in: documentVariants(search) } });
  return or;
}

export default new CustomerService();
