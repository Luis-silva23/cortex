/**
 * O middleware só lia `body.data`; a maioria das rotas de domínio (venda, pagamento, estoque, compra, fiscal,
 * caixa) responde com o objeto direto — a auditoria gravava newValue "null" e, na criação, entityId null.
 */
const addMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../config/queue', () => ({ jobQueue: { add: (...a: any[]) => addMock(...a) } }));
jest.mock('@ln-system/database', () => ({
  prisma: {},
  runWithRLSContext: (_c: any, fn: any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE' },
}));

import express from 'express';
import request from 'supertest';
import { auditLog } from './audit';

function appResponding(status: number, body: unknown) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 'u1', companyId: 'c1', userType: 'MANAGER' };
    next();
  });
  app.post('/x', auditLog('CREATE' as any, 'Payment'), (_req, res) => res.status(status).json(body));
  app.post('/x/:id', auditLog('UPDATE' as any, 'Payment'), (_req, res) => res.status(status).json(body));
  return app;
}

describe('auditLog grava o que aconteceu mesmo quando a resposta não tem `data`', () => {
  beforeEach(() => addMock.mockClear());

  it('resposta com o objeto direto: newValue é o objeto (segredos redigidos) e entityId é o id dele', async () => {
    await request(appResponding(201, { id: 'pay-1', companyId: 'c1', amount: 30, authorizationCode: 'SECRET' })).post('/x');
    const data = addMock.mock.calls[0][1];
    expect(data.entityId).toBe('pay-1');
    const newValue = JSON.parse(data.newValue);
    expect(newValue).toMatchObject({ id: 'pay-1', amount: 30 });
    expect(newValue.authorizationCode).toBe('[REDACTED]');
  });

  it('resposta envelopada ({ success, data }) continua usando `data`', async () => {
    await request(appResponding(200, { success: true, data: { id: 'x-2', status: 'PAID' } })).post('/x/x-2');
    const data = addMock.mock.calls[0][1];
    expect(data.entityId).toBe('x-2');
    expect(JSON.parse(data.newValue)).toEqual({ id: 'x-2', status: 'PAID' });
  });

  it('erro (4xx) não gera auditoria', async () => {
    await request(appResponding(400, { error: 'x' })).post('/x');
    expect(addMock).not.toHaveBeenCalled();
  });
});
