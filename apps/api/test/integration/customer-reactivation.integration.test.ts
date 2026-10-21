import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import customersRoutes from '../../src/routes/customers.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Cliente desativado × reativação — prova REAL (HTTP + Postgres/RLS, JWT real).
 *
 * ACHADO: DELETE /customers/:id é soft delete (isActive=false), mas não havia
 * caminho de volta: `updateCustomerSchema` não aceitava `isActive` (o de
 * produtos aceita), então um cliente desativado — por engano ou porque
 * voltou a comprar — ficava inativo para sempre (sumia da busca do PDV) e a
 * única saída era recadastrar, duplicando o documento e perdendo o histórico.
 * Reativar é a mesma edição (PUT, gerência+), auditada, sem tocar no histórico.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Cliente: desativar e REATIVAR (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let customerId: string;
  let saleId: string;

  const as = (f: IntegrationFixture, userType: string) => ({
    Authorization: `Bearer ${generateAccessToken({
      userId: f.userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: f.companyId,
      branchId: f.branchId,
      userType,
    })}`,
  });
  const customer = (id: string) => bypass<any>(() => prismaUnsafeBypassRLS.customer.findFirst({ where: { id } }));

  beforeAll(async () => {
    A = await createFixture('cust-react-A');
    B = await createFixture('cust-react-B');
    app = express();
    app.use(express.json());
    app.use('/api/customers', customersRoutes);
    app.use(errorHandler);

    customerId = (
      await bypass<{ id: string }>(() =>
        prismaUnsafeBypassRLS.customer.create({ data: { companyId: A.companyId, name: 'Cliente Reativável', document: '99988877766', isActive: true }, select: { id: true } })
      )
    ).id;
    // Histórico: uma venda desse cliente (não pode ser tocada pela desativação/reativação).
    saleId = (
      await bypass<{ id: string }>(() =>
        prismaUnsafeBypassRLS.sale.create({
          data: { companyId: A.companyId, branchId: A.branchId, saleNumber: 4001, customerId, userId: A.userId, cashRegisterId: A.cashRegisterId, status: 'PAID', subtotal: 10, totalAmount: 10 },
          select: { id: true },
        })
      )
    ).id;
  }, 30000);

  afterAll(async () => {
    await destroyFixture(A);
    await destroyFixture(B);
  }, 30000);

  it('desativar (DELETE) esconde o cliente da busca do PDV, mas mantém o histórico', async () => {
    const del = await request(app).delete(`/api/customers/${customerId}`).set(as(A, 'MANAGER'));
    expect(del.status).toBe(200);
    expect((await customer(customerId)).isActive).toBe(false);

    const search = await request(app).get('/api/customers/search?search=Reativ%C3%A1vel').set(as(A, 'OPERATOR'));
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain(customerId);

    const sale = await bypass<any>(() => prismaUnsafeBypassRLS.sale.findFirst({ where: { id: saleId } }));
    expect(sale.customerId).toBe(customerId);
  });

  it('OPERATOR e MECHANIC não reativam (403) e o cliente segue inativo', async () => {
    for (const userType of ['OPERATOR', 'MECHANIC', 'VIEWER']) {
      const res = await request(app).put(`/api/customers/${customerId}`).set(as(A, userType)).send({ isActive: true });
      expect(res.status).toBe(403);
    }
    expect((await customer(customerId)).isActive).toBe(false);
  });

  it('a empresa B não reativa o cliente da empresa A', async () => {
    const res = await request(app).put(`/api/customers/${customerId}`).set(as(B, 'MANAGER')).send({ isActive: true });
    expect(res.status).toBe(400);
    expect((await customer(customerId)).isActive).toBe(false);
  });

  it('isActive precisa ser booleano de verdade', async () => {
    const res = await request(app).put(`/api/customers/${customerId}`).set(as(A, 'MANAGER')).send({ isActive: 'sim' });
    expect(res.status).toBe(400);
    expect((await customer(customerId)).isActive).toBe(false);
  });

  it('MANAGER reativa (PUT isActive:true): volta à busca do PDV, com o mesmo id, documento e histórico', async () => {
    const res = await request(app).put(`/api/customers/${customerId}`).set(as(A, 'MANAGER')).send({ isActive: true });
    expect(res.status).toBe(200);

    const row = await customer(customerId);
    expect(row.isActive).toBe(true);
    expect(row.document).toBe('99988877766');

    const search = await request(app).get('/api/customers/search?search=Reativ%C3%A1vel').set(as(A, 'OPERATOR'));
    expect(JSON.stringify(search.body)).toContain(customerId);

    const sale = await bypass<any>(() => prismaUnsafeBypassRLS.sale.findFirst({ where: { id: saleId } }));
    expect(sale.customerId).toBe(customerId);
  });

  it('editar outros campos NÃO reativa nem desativa por acidente (isActive ausente = não mexe)', async () => {
    await request(app).delete(`/api/customers/${customerId}`).set(as(A, 'MANAGER'));
    const res = await request(app).put(`/api/customers/${customerId}`).set(as(A, 'MANAGER')).send({ notes: 'ligou pedindo peça' });
    expect(res.status).toBe(200);
    const row = await customer(customerId);
    expect(row.isActive).toBe(false);
    expect(row.notes).toBe('ligou pedindo peça');
  });
});
