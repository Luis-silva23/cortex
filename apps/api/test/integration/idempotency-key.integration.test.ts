import express from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * Header Idempotency-Key na rota real (POST /api/cash-register/open), com a constraint única e o RLS do Postgres.
 * Contrato: chave concluída devolve a mesma resposta sem reexecutar; corpo diferente é 422; chave FAILED (5xx anterior)
 * libera nova tentativa real. Este último caía em 409 e a chave ficava presa por 24h.
 */
describe('Idempotency-Key (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let token: string;
  const ENDPOINT = 'POST /api/cash-register/open';

  const open = (key: string, body: Record<string, unknown>) =>
    request(app).post('/api/cash-register/open').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const registers = (registerNumber: number) =>
    bypass<number>(() => db.cashRegister.count({ where: { companyId: fixture.companyId, registerNumber } }));
  const closeAll = () =>
    bypass(() => db.cashRegister.updateMany({ where: { companyId: fixture.companyId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } }));
  const keyRow = (key: string) =>
    bypass<any>(() => db.idempotencyKey.findUnique({ where: { companyId_endpoint_key: { companyId: fixture.companyId, endpoint: ENDPOINT, key } } }));
  // O middleware grava o resultado (COMPLETED) SEM esperar: `res.json` dispara o `update` e já responde (idempotency.ts). Quem lê a chave ou
  // repete a requisição logo depois da resposta corre contra essa gravação (falha intermitente no CI, 2026-10-22: `Expected "COMPLETED"
  // Received "PENDING"`; reproduzida de forma determinística atrasando o `update`). Aqui se espera, com limite, a gravação terminar.
  const waitStatus = async (key: string, status: string) => {
    let row = await keyRow(key);
    for (let i = 0; i < 100 && row?.status !== status; i++) {
      await new Promise((r) => setTimeout(r, 50));
      row = await keyRow(key);
    }
    return row;
  };
  const failedKey = (key: string, body: Record<string, unknown>) =>
    bypass(() =>
      db.idempotencyKey.create({
        data: {
          key,
          companyId: fixture.companyId,
          userId: fixture.userId,
          endpoint: ENDPOINT,
          requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
          status: 'FAILED',
          responseStatus: 500,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      })
    );

  beforeAll(async () => {
    fixture = await createFixture('idemkey');
    token = generateAccessToken({ userId: fixture.userId, email: 'idemkey@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType: 'COMPANY_ADMIN' });
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (!fixture?.companyId) return;
    const companyId = fixture.companyId;
    await bypass(() => db.idempotencyKey.deleteMany({ where: { companyId } }));
    await destroyFixture(fixture);
  });
  beforeEach(closeAll);

  it('chave concluída: a repetição devolve a mesma resposta e não abre outro caixa', async () => {
    const body = { branchId: fixture.branchId, registerNumber: 41, openingAmount: 10 };
    const first = await open('idem-replay', body);
    expect(first.status).toBe(201);
    expect((await waitStatus('idem-replay', 'COMPLETED')).status).toBe('COMPLETED');
    await closeAll();
    const again = await open('idem-replay', body);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect(await registers(41)).toBe(1);
    expect((await waitStatus('idem-replay', 'COMPLETED')).status).toBe('COMPLETED');
  });

  it('chave VENCIDA (expiresAt no passado): a janela de 24 h acabou — a mesma chave executa de novo e NÃO devolve a resposta antiga', async () => {
    const body = { branchId: fixture.branchId, registerNumber: 61, openingAmount: 10 };
    const first = await open('idem-expired', body);
    expect(first.status).toBe(201);
    await waitStatus('idem-expired', 'COMPLETED');
    await closeAll();
    const expired = await bypass<{ count: number }>(() =>
      db.idempotencyKey.updateMany({ where: { companyId: fixture.companyId, endpoint: ENDPOINT, key: 'idem-expired' }, data: { expiresAt: new Date(Date.now() - 1000) } })
    );
    expect(expired.count).toBe(1); // sem isto, um vencimento que não gravou viraria "replay" sem explicação
    const again = await open('idem-expired', body);
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(first.body.id); // operação nova, não replay
    expect(await registers(61)).toBe(2);
    const row = await waitStatus('idem-expired', 'COMPLETED');
    expect(row.status).toBe('COMPLETED');
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now()); // janela nova
  });

  it('mesma chave com corpo diferente: 422, nada executado', async () => {
    await open('idem-body', { branchId: fixture.branchId, registerNumber: 42, openingAmount: 10 });
    await closeAll();
    const res = await open('idem-body', { branchId: fixture.branchId, registerNumber: 43, openingAmount: 10 });
    expect(res.status).toBe(422);
    expect(await registers(43)).toBe(0);
  });

  it('chave FAILED (5xx anterior): a nova tentativa executa uma vez e fica COMPLETED', async () => {
    const body = { branchId: fixture.branchId, registerNumber: 44, openingAmount: 10 };
    await failedKey('idem-failed', body);
    const res = await open('idem-failed', body);
    expect(res.status).toBe(201);
    expect(await registers(44)).toBe(1);
    const row = await waitStatus('idem-failed', 'COMPLETED');
    expect(row.status).toBe('COMPLETED');
    expect(row.responseStatus).toBe(201);

    await closeAll();
    const replay = await open('idem-failed', body);
    expect(replay.body.id).toBe(res.body.id);
    expect(await registers(44)).toBe(1);
  });

  it('chave FAILED com três tentativas simultâneas: a operação roda uma vez só', async () => {
    const body = { branchId: fixture.branchId, registerNumber: 45, openingAmount: 10 };
    await failedKey('idem-race', body);
    const results = await Promise.all([open('idem-race', body), open('idem-race', body), open('idem-race', body)]);
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain(201);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(await registers(45)).toBe(1);
  });
});
