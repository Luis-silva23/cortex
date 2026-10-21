/**
 * ACHADO DA HOMOLOGAÇÃO (2026-10-04): com o Postgres interrompido por instantes, o login do Mecânico respondeu 503, mas
 * pelo caminho errado: o texto do erro do Prisma traz o trecho do código-fonte (`throw new Error('Credenciais inválidas')`),
 * a regex do `catch` o tomou por credencial errada, registrou "Failed login attempt" e tentou gravar `LOGIN_FAILED` (que
 * também falhou). Queda de banco não é falha de credencial: o login devolve 503 + Retry-After (mesmo contrato de antes) e
 * não grava `LOGIN_FAILED`. Erro do Prisma de qualquer código também nunca vira "credencial inválida".
 */

const login = jest.fn();
jest.mock('../services/auth.service', () => ({
  AuthService: jest.fn().mockImplementation(() => ({ login: (...a: any[]) => login(...a) })),
  MfaEnrollmentRequiredError: class MfaEnrollmentRequiredError extends Error {},
  PasswordChangeRequiredError: class PasswordChangeRequiredError extends Error {},
  PasswordChangeError: class PasswordChangeError extends Error {},
}));
jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitAuth: (_req: any, _res: any, next: any) => next(),
  rateLimitMFA: (_req: any, _res: any, next: any) => next(),
  rateLimitAuthorizer: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const createAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../middleware/audit', () => ({ createAuditLog: (...a: any[]) => createAuditLog(...a) }));
jest.mock('../middleware/auth', () => ({ authMiddleware: (_req: any, _res: any, next: any) => next() }));
jest.mock('../middleware/tenant', () => ({ tenantIsolation: (_req: any, _res: any, next: any) => next() }));
const findFirst = jest.fn().mockResolvedValue(null);
jest.mock('@ln-system/database', () => ({
  AuditAction: { LOGIN: 'LOGIN', LOGIN_FAILED: 'LOGIN_FAILED' },
  prisma: { user: { findFirst: (...a: any[]) => findFirst(...a) } },
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
}));
jest.mock('../services/device-session.service', () => ({
  DeviceSessionError: class DeviceSessionError extends Error {},
  DeviceAuthError: class DeviceAuthError extends Error {},
}));
jest.mock('../services/access-token-revocation', () => ({ revokeAccessToken: jest.fn() }));
jest.mock('@ln-system/shared/utils/token', () => ({ verifyAccessToken: jest.fn() }));
jest.mock('../services/logger.service', () => ({ Logger: { critical: jest.fn(), warn: jest.fn() } }));

import express from 'express';
import request from 'supertest';
import authRoutes from './auth.routes';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);

// Texto real que o Prisma devolve: o quadro do código-fonte cita 'Credenciais inválidas'.
const PRISMA_FRAME =
  "\nInvalid `database_1.prisma.user.findUnique()` invocation in\nauth.service.js:113:55\n\n  110     throw new Error('Credenciais inválidas');\n" +
  '  111 }\n→ 113     const user = await database_1.prisma.user.findUnique(\n';

function prismaError(code: string, tail: string) {
  return Object.assign(new Error(PRISMA_FRAME + tail), { name: 'PrismaClientKnownRequestError', code });
}

const body = { email: 'mecanico.a1@hml.local', password: 'qualquer' };
const settle = () => new Promise((r) => setImmediate(r));

describe('POST /auth/login — erro de banco não é credencial inválida', () => {
  beforeEach(() => {
    login.mockReset();
    createAuditLog.mockClear();
    findFirst.mockClear();
  });

  it('P1017 (servidor fechou a conexão): 503 + Retry-After, sem LOGIN_FAILED e sem consulta de auditoria', async () => {
    login.mockRejectedValueOnce(prismaError('P1017', 'Server has closed the connection.'));
    const res = await request(app).post('/auth/login').send(body);
    await settle();
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.code).toBe('DATABASE_UNAVAILABLE');
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('P2024 (pool esgotado) também é indisponibilidade, não credencial', async () => {
    login.mockRejectedValueOnce(prismaError('P2024', 'Timed out fetching a new connection from the connection pool.'));
    const res = await request(app).post('/auth/login').send(body);
    await settle();
    expect(res.status).toBe(503);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('outro erro do Prisma cujo texto cita a credencial NÃO é tratado como credencial: 500 e sem LOGIN_FAILED', async () => {
    login.mockRejectedValueOnce(prismaError('P2025', 'An operation failed because it depends on one or more records that were required but not found.'));
    const res = await request(app).post('/auth/login').send(body);
    await settle();
    expect(res.status).toBe(500);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('controle: credencial realmente inválida segue 401 e grava LOGIN_FAILED', async () => {
    login.mockRejectedValueOnce(new Error('Credenciais inválidas'));
    const res = await request(app).post('/auth/login').send(body);
    await settle();
    expect(res.status).toBe(401);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOGIN_FAILED' }));
  });
});
