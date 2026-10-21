/**
 * PRE-PRODUCTION HARDENING (Backend/API): `maxDiscount` só era validado
 * quanto à presença, nunca quanto ao valor — negativo, NaN ou >100% num
 * discountType PERCENTAGE passavam direto para o banco. Ver comentário em
 * discount-rules.routes.ts::validateMaxDiscount.
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitGeneral: (_req: any, _res: any, next: any) => next(),
}));

const findManyMock = jest.fn().mockResolvedValue([]);
const findFirstMock = jest.fn().mockResolvedValue({ id: 'rule-1', discountType: 'PERCENTAGE' });
const createMock = jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'rule-new', ...data }));
const updateMock = jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'rule-1', ...data }));

jest.mock('@ln-system/database', () => ({
  prisma: {
    discountRule: {
      findMany: (...args: any[]) => findManyMock(...args),
      findFirst: (...args: any[]) => findFirstMock(...args),
      create: (...args: any[]) => createMock(...args),
      update: (...args: any[]) => updateMock(...args),
    },
    // requireModuleEnabled('VENDAS') (aplicado a esta rota nesta sessão)
    // consulta isto a cada request — vazio = nenhuma configuração de módulo
    // registrada = módulo habilitado por padrão (opt-out), o comportamento
    // que todo teste abaixo já assume implicitamente.
    companyModuleSetting: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
  // Simplificado para o teste de rota: não precisa da semântica real de
  // AsyncLocalStorage, só precisa executar o callback (o middleware de
  // auditoria/tenant não é o alvo deste teste).
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import discountRulesRoutes from './discount-rules.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discount-rules', discountRulesRoutes);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  findManyMock.mockResolvedValue([]);
  findFirstMock.mockResolvedValue({ id: 'rule-1', discountType: 'PERCENTAGE' });
  verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'COMPANY_ADMIN', companyId: 'company-A' });
});

describe('POST /api/discount-rules — validação de maxDiscount', () => {
  const app = buildApp();

  it('rejeita maxDiscount negativo', async () => {
    const res = await request(app)
      .post('/api/discount-rules')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Regra', discountType: 'PERCENTAGE', maxDiscount: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/negativo/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejeita maxDiscount não numérico (NaN)', async () => {
    const res = await request(app)
      .post('/api/discount-rules')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Regra', discountType: 'PERCENTAGE', maxDiscount: 'não-é-número' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/número válido/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejeita maxDiscount > 100 quando discountType é PERCENTAGE', async () => {
    const res = await request(app)
      .post('/api/discount-rules')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Regra', discountType: 'PERCENTAGE', maxDiscount: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('aceita maxDiscount > 100 quando discountType é FIXED (valor em R$, não %)', async () => {
    const res = await request(app)
      .post('/api/discount-rules')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Regra', discountType: 'FIXED', maxDiscount: 500 });
    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('aceita um maxDiscount válido dentro da faixa', async () => {
    const res = await request(app)
      .post('/api/discount-rules')
      .set('Authorization', 'Bearer t')
      .send({ name: 'Regra', discountType: 'PERCENTAGE', maxDiscount: 10 });
    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ maxDiscount: 10 }) })
    );
  });
});

describe('PUT /api/discount-rules/:id — validação de maxDiscount', () => {
  const app = buildApp();

  it('rejeita atualizar para um maxDiscount negativo', async () => {
    const res = await request(app)
      .put('/api/discount-rules/rule-1')
      .set('Authorization', 'Bearer t')
      .send({ maxDiscount: -1 });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejeita atualizar para >100% quando a regra existente já é PERCENTAGE (discountType não reenviado)', async () => {
    findFirstMock.mockResolvedValue({ id: 'rule-1', discountType: 'PERCENTAGE' });
    const res = await request(app)
      .put('/api/discount-rules/rule-1')
      .set('Authorization', 'Bearer t')
      .send({ maxDiscount: 200 });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
