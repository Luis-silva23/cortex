import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS } from '@ln-system/database';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Cache (Redis) × empresa/filial — prova REAL (HTTP + Postgres/RLS + Redis).
 *
 * O Redis não passa pela RLS: o que é guardado sob a chave errada é entregue a
 * quem não devia. Achados desta bateria:
 *  1) `GET /products/:id/stock` consultava o cache ANTES de conferir a empresa
 *     (chave `product:<id>:stock`): a empresa B lia o saldo de um produto da A.
 *  2) `?branchId=` forjado calculava o saldo sob a RLS do requisitante (parcial) e
 *     gravava sob a chave da filial pedida: o administrador recebia depois o saldo
 *     parcial (envenenamento de cache entre filiais).
 *  3) `GET /dashboard/stock` guardava o valor de estoque a custo sob
 *     `dashboard:stock:<empresa>:all:...` sem olhar quem calculou: o total da empresa
 *     toda (do administrador) era entregue ao gerente de uma filial, e vice-versa.
 */

describe('Cache com escopo de empresa/filial (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;

  const A = () => world.A;
  const a1Operator = () => bearer(tokenFor(A(), 1, 'OPERATOR'));
  const a1Manager = () => bearer(tokenFor(A(), 1, 'MANAGER'));
  const aAdmin = () => bearer(tokenFor(A(), null, 'COMPANY_ADMIN'));
  const b1Operator = () => bearer(tokenFor(world.B, 1, 'OPERATOR'));

  const movement = (productId: string, branchId: string, quantity: number) =>
    bypass(() =>
      prismaUnsafeBypassRLS.stockMovement.create({
        data: { companyId: A().companyId, branchId, productId, movementType: 'PURCHASE', quantity, userId: A().branches[1].userId, unitCost: 5 },
      })
    );

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    // Estoque com valores conhecidos: produto da A1 tem 7 na A1 e 5 na A2.
    await movement(A().branches[1].productId, A().branches[1].branchId, 7);
    await movement(A().branches[1].productId, A().branches[2].branchId, 5);
    // Estoque da A2 (para o dashboard: a A2 tem mais do que a A1)
    await movement(A().branches[2].productId, A().branches[2].branchId, 40);
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await destroyWorld(world);
  }, 120000);

  it('saldo por produto: a empresa B NÃO lê pelo cache o saldo do produto da empresa A', async () => {
    const productId = A().branches[1].productId;

    const own = await request(app).get(`/api/products/${productId}/stock`).set(a1Operator());
    expect(own.status).toBe(200); // popula o cache do dono

    const other = await request(app).get(`/api/products/${productId}/stock`).set(b1Operator());
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(other.body)).not.toContain(productId);
    expect(other.body.balance).toBeUndefined();
  });

  it('saldo por produto: ?branchId= forjado do operador NÃO envenena o saldo que o administrador recebe depois', async () => {
    const productId = A().branches[1].productId;
    const a2 = A().branches[2].branchId;

    // o operador da A1 pede o saldo "da filial A2": a RLS esconde os movimentos da A2 dele
    await request(app).get(`/api/products/${productId}/stock?branchId=${a2}`).set(a1Operator());

    // o administrador pede o MESMO saldo: tem que ser o real (5 na A2), não o parcial do operador
    const admin = await request(app).get(`/api/products/${productId}/stock?branchId=${a2}`).set(aAdmin());
    expect(admin.status).toBe(200);
    expect(Number(admin.body.balance)).toBe(5);
  });

  it('dashboard de estoque: o total do administrador (empresa toda) NÃO vai para o gerente da filial, e vice-versa', async () => {
    const value = (res: request.Response) => Number(res.body.totalStockValue);

    // referências frescas (staleDays distintos => chaves distintas)
    const managerRef = await request(app).get('/api/dashboard/stock?staleDays=91').set(a1Manager());
    const adminRef = await request(app).get('/api/dashboard/stock?staleDays=92').set(aAdmin());
    expect(managerRef.status).toBe(200);
    expect(adminRef.status).toBe(200);
    expect(value(adminRef)).toBeGreaterThan(value(managerRef)); // a A2 tem estoque que a A1 não enxerga

    // administrador primeiro, depois o gerente: o gerente NÃO pode receber o total do administrador
    await request(app).get('/api/dashboard/stock?staleDays=93').set(aAdmin());
    const managerAfterAdmin = await request(app).get('/api/dashboard/stock?staleDays=93').set(a1Manager());
    expect(value(managerAfterAdmin)).toBe(value(managerRef));

    // gerente primeiro, depois o administrador: o administrador NÃO pode receber o parcial do gerente
    await request(app).get('/api/dashboard/stock?staleDays=94').set(a1Manager());
    const adminAfterManager = await request(app).get('/api/dashboard/stock?staleDays=94').set(aAdmin());
    expect(value(adminAfterManager)).toBe(value(adminRef));
  });

  it('a segunda consulta do MESMO escopo continua vindo do cache (o cache não foi desligado)', async () => {
    const first = await request(app).get('/api/dashboard/stock?staleDays=95').set(a1Manager());
    const second = await request(app).get('/api/dashboard/stock?staleDays=95').set(a1Manager());
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});
