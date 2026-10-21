import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, runWithRLSContext, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import stockRoutes from '../../src/routes/stock.routes';
import stockService from '../../src/services/stock.service';
import { jobQueue } from '../../src/config/queue';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createFixture, destroyFixture, IntegrationFixture, purgeStockMovements } from './helpers/fixture';

// `stock:adjust` é permissão RBAC sem seed (docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md E1a). O que se prova
// aqui é a regra de FILIAL do ajuste, então a permissão passa direto — o resto do
// middleware de permissão é o real.
jest.mock('../../src/middleware/permission', () => {
  const actual = jest.requireActual('../../src/middleware/permission');
  return { ...actual, requirePermission: () => (_req: any, _res: any, next: any) => next() };
});

/**
 * Ajuste de estoque × filial — prova REAL (HTTP + Postgres/RLS, JWT real).
 *
 * ACHADO DE AUDITORIA: `POST /stock/adjustment` (e /movement) aceitavam
 * `branchId` ausente. `adjustStock` então calculava a diferença contra o saldo
 * TOTAL da empresa (soma de todas as filiais) e gravava um movimento com filial
 * NULL — que não entra no saldo de nenhuma filial: o ledger deixava de fechar por
 * filial (a tela de ajuste avulso do Admin Web mandava exatamente isso). Agora a
 * filial é obrigatória (padrão: a do token) e quem é de uma filial só mexe na sua.
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Ajuste de estoque exige filial (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let branch2: string;

  const token = (f: IntegrationFixture, userType: string, withBranch = true) =>
    generateAccessToken({
      userId: f.userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: f.companyId,
      branchId: (withBranch ? f.branchId : undefined) as any,
      userType,
    });
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const movements = (productId: string) =>
    bypass<any[]>(() => prismaUnsafeBypassRLS.stockMovement.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } }));
  // getBalance usa o cliente com RLS: precisa de contexto de empresa (admin: enxerga todas as filiais).
  const balanceOf = async (branchId?: string) =>
    (
      await runWithRLSContext({ companyId: A.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        stockService.getBalance(A.productId, A.companyId, branchId)
      )
    ).balance;

  const seed = async (branchId: string, quantity: number) =>
    bypass(() =>
      prismaUnsafeBypassRLS.stockMovement.create({
        data: { companyId: A.companyId, branchId, productId: A.productId, movementType: 'PURCHASE', quantity, userId: A.userId, notes: 'seed do teste' },
      })
    );

  beforeAll(async () => {
    A = await createFixture('stock-adj-A');
    B = await createFixture('stock-adj-B');
    app = express();
    app.use(express.json());
    app.use('/api/stock', stockRoutes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    branch2 = (
      await bypass<{ id: string }>(() =>
        prismaUnsafeBypassRLS.branch.create({ data: { companyId: A.companyId, name: 'Filial 2', isActive: true }, select: { id: true } })
      )
    ).id;
    // O fixture já semeia estoque na filial 1; limpa para controlar os saldos do teste.
    // escopado por empresa (antes só por productId: com productId undefined apagava o estoque de TODAS as empresas)
    await purgeStockMovements(A.companyId, A.productId);
    await seed(A.branchId, 10);
    await seed(branch2, 5);
  }, 30000);

  afterAll(async () => {
    auditSpy.mockRestore();
    await destroyFixture(A);
    await destroyFixture(B);
  }, 30000);

  it('sem branchId no corpo: usa a filial do TOKEN e calcula contra o saldo DESSA filial (não o total da empresa)', async () => {
    expect(await balanceOf(A.branchId)).toBe(10);
    expect(await balanceOf(branch2)).toBe(5);

    const res = await request(app)
      .post('/api/stock/adjustment')
      .set(auth(token(A, 'MANAGER')))
      .send({ productId: A.productId, newQuantity: 8, reason: 'contagem da loja' });

    expect(res.status).toBe(201);
    expect(res.body.branchId).toBe(A.branchId);
    expect(Number(res.body.quantity)).toBe(-2); // 10 → 8 na filial 1 (contra o total 15 seria -7)
    expect(await balanceOf(A.branchId)).toBe(8);
    expect(await balanceOf(branch2)).toBe(5);
  });

  it('COMPANY_ADMIN sem filial no token e sem branchId: 400 claro e NADA é gravado', async () => {
    const before = (await movements(A.productId)).length;
    const res = await request(app)
      .post('/api/stock/adjustment')
      .set(auth(token(A, 'COMPANY_ADMIN', false)))
      .send({ productId: A.productId, newQuantity: 99, reason: 'sem filial' });

    expect(res.status).toBe(400);
    expect(res.body.error ?? res.body.message).toMatch(/branchId|filial/i);
    expect((await movements(A.productId)).length).toBe(before);
    expect((await movements(A.productId)).every((m) => m.branchId !== null)).toBe(true);
  });

  it('COMPANY_ADMIN informa a filial: ajusta aquela filial (diferença contra o saldo dela)', async () => {
    const res = await request(app)
      .post('/api/stock/adjustment')
      .set(auth(token(A, 'COMPANY_ADMIN', false)))
      .send({ productId: A.productId, branchId: branch2, newQuantity: 9, reason: 'recontagem filial 2' });

    expect(res.status).toBe(201);
    expect(res.body.branchId).toBe(branch2);
    expect(Number(res.body.quantity)).toBe(4); // 5 → 9
    expect(await balanceOf(branch2)).toBe(9);
    expect(await balanceOf(A.branchId)).toBe(8);
  });

  it('o saldo por filial fecha com o total da empresa (nenhum movimento órfão sem filial)', async () => {
    const total = await balanceOf(undefined);
    expect(total).toBe((await balanceOf(A.branchId)) + (await balanceOf(branch2)));
    expect((await movements(A.productId)).filter((m) => m.branchId === null)).toHaveLength(0);
  });

  it('MANAGER de uma filial NÃO ajusta o estoque de OUTRA filial (403) e nada é gravado', async () => {
    const before = (await movements(A.productId)).length;
    const res = await request(app)
      .post('/api/stock/adjustment')
      .set(auth(token(A, 'MANAGER')))
      .send({ productId: A.productId, branchId: branch2, newQuantity: 1, reason: 'tentativa' });

    expect(res.status).toBe(403);
    expect((await movements(A.productId)).length).toBe(before);
    expect(await balanceOf(branch2)).toBe(9);
  });

  it('filial de OUTRA empresa é recusada (4xx) e nada é gravado', async () => {
    const before = (await movements(A.productId)).length;
    const res = await request(app)
      .post('/api/stock/adjustment')
      .set(auth(token(A, 'COMPANY_ADMIN', false)))
      .send({ productId: A.productId, branchId: B.branchId, newQuantity: 3, reason: 'filial alheia' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await movements(A.productId)).length).toBe(before);
  });

  it('a mesma regra vale para POST /stock/movement (filial obrigatória; padrão: a do token)', async () => {
    const noBranch = await request(app)
      .post('/api/stock/movement')
      .set(auth(token(A, 'COMPANY_ADMIN', false)))
      .send({ productId: A.productId, movementType: 'PURCHASE', quantity: 1 });
    expect(noBranch.status).toBe(400);

    const defaulted = await request(app)
      .post('/api/stock/movement')
      .set(auth(token(A, 'MANAGER')))
      .send({ productId: A.productId, movementType: 'PURCHASE', quantity: 1 });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.branchId).toBe(A.branchId);
  });

  it('o ajuste é auditado (quem, o quê)', async () => {
    const audits = auditSpy.mock.calls.map((c) => c[1]).filter((p) => p.entity === 'StockMovement');
    expect(audits.length).toBeGreaterThan(0);
  });
});
