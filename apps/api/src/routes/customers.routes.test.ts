/**
 * ACHADO DE AUDITORIA: nenhum write deste arquivo tinha trava de papel —
 * inclusive VIEWER (papel só-leitura por definição no resto do sistema)
 * conseguia criar/editar/apagar cliente. Diferente de suppliers/products/
 * partners, CRIAR cliente é um fluxo real do PDV (CustomerSearchModal.tsx
 * chama createCustomer() no cadastro avulso de balcão) — por isso a
 * criação exclui só o VIEWER, mantendo OPERATOR/MECHANIC funcionando.
 * Editar/apagar só têm chamador real em admin-web (backoffice), então
 * recebem o padrão Gerência+ já usado em suppliers/products/categories.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('@ln-system/shared/src/validators/pdv.validators', () => ({
  customerSchema: { parse: (data: any) => data },
  updateCustomerSchema: { parse: (data: any) => data },
  customerSearchSchema: { parse: (data: any) => data },
}));

const listCustomersMock = jest.fn().mockResolvedValue({ customers: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
const getCustomerByIdMock = jest.fn().mockResolvedValue({ id: 'customer-1', name: 'Cliente X' });
const findByDocumentMock = jest.fn().mockResolvedValue(null);
const createCustomerMock = jest.fn().mockResolvedValue({ id: 'customer-new', name: 'Cliente Novo' });
const updateCustomerMock = jest.fn().mockResolvedValue({ id: 'customer-1', name: 'Cliente Atualizado' });
const deleteCustomerMock = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/customer.service', () => ({
  __esModule: true,
  default: {
    listCustomers: (...args: any[]) => listCustomersMock(...args),
    getCustomerById: (...args: any[]) => getCustomerByIdMock(...args),
    findByDocument: (...args: any[]) => findByDocumentMock(...args),
    createCustomer: (...args: any[]) => createCustomerMock(...args),
    updateCustomer: (...args: any[]) => updateCustomerMock(...args),
    deleteCustomer: (...args: any[]) => deleteCustomerMock(...args),
    searchCustomers: jest.fn().mockResolvedValue([]),
    getCustomerStats: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('@ln-system/database', () => ({
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import customersRoutes from './customers.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/customers', customersRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  listCustomersMock.mockResolvedValue({ customers: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  getCustomerByIdMock.mockResolvedValue({ id: 'customer-1', name: 'Cliente X' });
  findByDocumentMock.mockResolvedValue(null);
  createCustomerMock.mockResolvedValue({ id: 'customer-new', name: 'Cliente Novo' });
  updateCustomerMock.mockResolvedValue({ id: 'customer-1', name: 'Cliente Atualizado' });
});

describe('customers.routes — criação aberta a operação, edição/exclusão restritas a Gerência+', () => {
  const app = buildApp();

  it('bloqueia VIEWER de criar cliente (POST) com 403 — papel só-leitura não pode escrever', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Cliente Hostil' });

    expect(res.status).toBe(403);
    expect(createCustomerMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('permite %s criar cliente (POST) — fluxo real do PDV/oficina', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Cliente Balcão' });

    expect(res.status).toBe(201);
    expect(createCustomerMock).toHaveBeenCalledTimes(1);
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s criar cliente (POST)', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Cliente Legítimo' });

    expect(res.status).toBe(201);
  });

  it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])('bloqueia %s de editar cliente (PUT) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app)
      .put('/api/customers/customer-1')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Reescrito sem autorização' });

    expect(res.status).toBe(403);
    expect(updateCustomerMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])('bloqueia %s de apagar cliente (DELETE) com 403', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const res = await request(app).delete('/api/customers/customer-1').set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(deleteCustomerMock).not.toHaveBeenCalled();
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'])('permite %s editar (PUT) e apagar (DELETE) cliente', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const putRes = await request(app)
      .put('/api/customers/customer-1')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Atualizado' });
    expect(putRes.status).toBe(200);

    const deleteRes = await request(app).delete('/api/customers/customer-1').set('Authorization', 'Bearer t');
    expect(deleteRes.status).toBe(200);
  });

  describe('mensagens de erro do cadastro (PDV/Admin Web) — sem vazar erro cru do Prisma', () => {
    const create = () =>
      request(app).post('/api/customers').set('Authorization', 'Bearer t').send({ name: 'Cliente Balcão' });

    beforeEach(() => {
      verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'OPERATOR', companyId: 'company-A' });
    });

    // 2026-09-27: duplicidade é conflito de regra (409, código CUSTOMER_DOCUMENT_DUPLICATE, mensagem PT-BR) — antes 400
    // com texto em inglês. Nenhuma tela dependia do texto antigo (PDV e Admin Web só exibem `error`).
    it('conflito na unique [companyId, document] (P2002) vira 409 com mensagem amigável de duplicidade', async () => {
      createCustomerMock.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed on C:\\srv\\x.ts'), { code: 'P2002' }));

      const res = await create();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CUSTOMER_DOCUMENT_DUPLICATE');
      expect(res.body.error).toBe('Já existe cliente com este CPF/CNPJ nesta empresa.');
      expect(JSON.stringify(res.body)).not.toContain('x.ts');
    });

    it('outros erros do Prisma não expõem o texto interno (caminho de arquivo, query)', async () => {
      createCustomerMock.mockRejectedValueOnce(
        Object.assign(new Error('Invalid `prisma.customer.create()` invocation in C:\\srv\\customer.service.ts:8:34'), {
          name: 'PrismaClientKnownRequestError',
          code: 'P2003',
        })
      );

      const res = await create();

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Não foi possível salvar o cliente');
      expect(JSON.stringify(res.body)).not.toContain('customer.service.ts');
    });

    it('erro de validação do Zod vira "campo: mensagem" legível em vez de blob JSON', async () => {
      createCustomerMock.mockRejectedValueOnce(
        Object.assign(new Error('[{"path":["email"]}]'), {
          name: 'ZodError',
          issues: [{ path: ['email'], message: 'Invalid email' }],
        })
      );

      const res = await create();

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('email: Invalid email');
    });
  });

  it('NÃO restringe leitura (GET /, /search, /:id) — qualquer usuário autenticado do tenant continua consultando clientes', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const listRes = await request(app).get('/api/customers').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);

    const getRes = await request(app).get('/api/customers/customer-1').set('Authorization', 'Bearer t');
    expect(getRes.status).toBe(200);
  });
});
