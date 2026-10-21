import express from 'express';
import request from 'supertest';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import salesRoutes from '../../src/routes/sales.routes';
import paymentsRoutes from '../../src/routes/payments.routes';
import cashRegisterRoutes from '../../src/routes/cash-register.routes';
import financialRoutes from '../../src/routes/financial.routes';
import purchaseOrdersRoutes from '../../src/routes/purchase-orders.routes';
import fiscalRoutes from '../../src/routes/fiscal.routes';
import dashboardRoutes from '../../src/routes/dashboard.routes';
import userRoutes from '../../src/routes/user.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { bypass } from './helpers/tenant-world';

/**
 * Leitura por papel — prova REAL (HTTP + Postgres/RLS, JWT real).
 *
 * ACHADOS DE AUDITORIA (mapeamento do papel MECHANIC, reverificados):
 * 1) Um MECHANIC (papel de OFICINA) lia dados de dinheiro da empresa inteira:
 *    vendas (com custo dos itens e dados de cartão dos pagamentos), pagamentos,
 *    histórico de caixa, contas a pagar/receber, pedidos de compra (custo unitário),
 *    documentos fiscais e os dashboards de vendas/estoque(valor a custo)/PDV/CEO.
 *    Nenhuma dessas rotas é usada por ele (mobile/TV/PDV não as chamam como MECHANIC).
 * 2) GET /users, /users/:id e /users/:id/roles eram abertos a QUALQUER papel, com
 *    e-mail, telefone, `numericId` (login/autorizador), `mfaEnabled`, `lastLoginAt`
 *    e perfis dos colegas. Quem só precisa do nome (ex.: o seletor de mecânico da OS)
 *    recebe agora id/nome/perfil/ativo; a listagem completa é de gerência+.
 */

describe('Leitura por papel (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;

  const as = (userType: string) => ({
    Authorization: `Bearer ${generateAccessToken({
      userId: fixture.userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType,
    })}`,
  });

  beforeAll(async () => {
    fixture = await createFixture('read-scope');
    // o escopo de filiais vem do BANCO: os "outros usuários" dos testes precisam existir de verdade na filial do fixture
    for (const [id, userType] of [['00000000-0000-4000-8000-000000000001', 'OPERATOR'], ['00000000-0000-4000-8000-000000000002', 'MANAGER']] as const) {
      await bypass(() => db.user.create({ data: { id, companyId: fixture.companyId, branchId: fixture.branchId, name: `Colega ${userType}`, email: `colega-${userType.toLowerCase()}-${Date.now()}@test.local`, password: 'not-a-real-hash', userType, isActive: true } }));
    }
    app = express();
    app.use(express.json());
    app.use('/api/sales', salesRoutes);
    app.use('/api/payments', paymentsRoutes);
    app.use('/api/cash-register', cashRegisterRoutes);
    app.use('/api/financial', financialRoutes);
    app.use('/api/purchase-orders', purchaseOrdersRoutes);
    app.use('/api/fiscal', fiscalRoutes);
    app.use('/api/dashboard', dashboardRoutes);
    app.use('/api/users', userRoutes);
    app.use(errorHandler);
  }, 30000);

  afterAll(async () => {
    await destroyFixture(fixture);
  }, 30000);

  const MONEY_READS = [
    '/api/sales',
    '/api/sales/stats',
    '/api/payments',
    '/api/cash-register/history',
    '/api/financial/payables',
    '/api/financial/receivables',
    '/api/purchase-orders',
    '/api/fiscal/documents',
    '/api/dashboard/sales',
    '/api/dashboard/stock',
    '/api/dashboard/pdv',
    '/api/dashboard/ceo',
  ];

  describe('MECHANIC não lê dados de dinheiro da empresa', () => {
    it.each(MONEY_READS)('GET %s → 403', async (path) => {
      const res = await request(app).get(path).set(as('MECHANIC'));
      expect(res.status).toBe(403);
    });

    it('o que a oficina precisa continua aberto: dashboard da oficina', async () => {
      const res = await request(app).get('/api/dashboard/workshop').set(as('MECHANIC'));
      expect(res.status).toBe(200);
    });
  });

  describe('OPERATOR e VIEWER continuam lendo (o PDV e o backoffice dependem disso)', () => {
    it.each(['OPERATOR', 'VIEWER'])('%s lê vendas, caixa e pagamentos', async (userType) => {
      for (const path of ['/api/sales', '/api/sales/stats', '/api/payments', '/api/cash-register/history', '/api/purchase-orders', '/api/fiscal/documents']) {
        const res = await request(app).get(path).set(as(userType));
        expect([path, res.status]).toEqual([path, 200]);
      }
    });

    it('MANAGER e COMPANY_ADMIN leem os dashboards de gestão', async () => {
      for (const userType of ['MANAGER', 'COMPANY_ADMIN']) {
        for (const path of ['/api/dashboard/sales', '/api/dashboard/stock', '/api/dashboard/pdv']) {
          const res = await request(app).get(path).set(as(userType));
          expect([userType, path, res.status]).toEqual([userType, path, 200]);
        }
      }
    });
  });

  describe('diretório de usuários: só o necessário para quem não é gerência', () => {
    const SLIM_KEYS = ['id', 'isActive', 'name', 'userType'];

    it.each(['OPERATOR', 'MECHANIC', 'VIEWER'])('%s: listagem traz só id, nome, perfil e ativo', async (userType) => {
      const res = await request(app).get('/api/users?limit=100').set(as(userType));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const user of res.body.data) {
        expect(Object.keys(user).sort()).toEqual(SLIM_KEYS);
      }
    });

    it.each(['MANAGER', 'COMPANY_ADMIN'])('%s: listagem completa continua (e-mail, numericId…)', async (userType) => {
      const res = await request(app).get('/api/users?limit=100').set(as(userType));
      expect(res.status).toBe(200);
      const user = res.body.data[0];
      expect(user).toHaveProperty('email');
      expect(user).toHaveProperty('numericId');
      expect(user).not.toHaveProperty('password');
    });

    it('o filtro do seletor de mecânicos continua funcionando para quem é só operacional', async () => {
      const res = await request(app).get('/api/users?userType=OPERATOR&isActive=true').set(as('MECHANIC'));
      expect(res.status).toBe(200);
      expect(res.body.data.every((u: any) => u.userType === 'OPERATOR')).toBe(true);
    });

    it('GET /users/:id: o próprio registro é completo; o de outro, enxuto', async () => {
      const own = await request(app).get(`/api/users/${fixture.userId}`).set(as('OPERATOR'));
      expect(own.status).toBe(200);
      expect(own.body.data).toHaveProperty('email');

      // outro usuário: o id do fixture visto por um token de OUTRO userId
      const otherToken = generateAccessToken({
        userId: '00000000-0000-4000-8000-000000000001',
        email: 'x@test.local',
        companyId: fixture.companyId,
        branchId: fixture.branchId,
        userType: 'MECHANIC',
      });
      const other = await request(app).get(`/api/users/${fixture.userId}`).set({ Authorization: `Bearer ${otherToken}` });
      expect(other.status).toBe(200);
      expect(Object.keys(other.body.data).sort()).toEqual(['id', 'isActive', 'name', 'userType']);
    });

    it('GET /users/:id/roles de outro usuário é só de gerência+ (o próprio, aberto)', async () => {
      const tokenOf = (userId: string, userType: string) => ({
        Authorization: `Bearer ${generateAccessToken({ userId, email: 'x@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType })}`,
      });

      const denied = await request(app).get(`/api/users/${fixture.userId}/roles`).set(tokenOf('00000000-0000-4000-8000-000000000001', 'OPERATOR'));
      expect(denied.status).toBe(403);

      const own = await request(app).get(`/api/users/${fixture.userId}/roles`).set(as('OPERATOR'));
      expect(own.status).toBe(200);

      const manager = await request(app).get(`/api/users/${fixture.userId}/roles`).set(tokenOf('00000000-0000-4000-8000-000000000002', 'MANAGER'));
      expect(manager.status).toBe(200);
    });
  });
});
