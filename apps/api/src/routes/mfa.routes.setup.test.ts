/**
 * ACHADO DE AUDITORIA (segurança): `POST /mfa/setup` sobrescrevia `mfaSecret` e
 * `mfaBackupCodes` MESMO com o MFA já ativo (`mfaEnabled` seguia true). O login
 * passava a exigir TOTP contra o segredo novo: o dono ficava trancado para
 * fora e quem tivesse só um access token roubado trocava o segundo fator. Agora
 * com MFA ativo responde 409 e não toca no que está gravado — para trocar, é
 * preciso desativar antes (POST /mfa/disable, que exige a senha).
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('../middleware/tenant', () => ({
  tenantIsolation: (_req: any, _res: any, next: any) => next(),
}));

// A checagem de revogação (Redis + PostgreSQL) tem teste próprio: aqui ela é neutra (a falha fechada não faz parte deste caso).
jest.mock('../services/access-token-revocation', () => ({ isAccessTokenRevoked: async () => false }));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../middlewares/advancedRateLimit', () => ({
  rateLimitMFA: (_req: any, _res: any, next: any) => next(),
  rateLimitGeneral: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() } }));

jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

const generateSecretMock = jest.fn();
jest.mock('../services/MFAService', () => ({
  mfaService: {
    generateSecret: (...args: any[]) => generateSecretMock(...args),
    hashBackupCode: (code: string) => `hash:${code}`,
  },
}));

const findUniqueMock = jest.fn();
const updateMock = jest.fn();
jest.mock('@ln-system/database', () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => findUniqueMock(...args),
      update: (...args: any[]) => updateMock(...args),
    },
  },
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
}));

import express from 'express';
import request from 'supertest';
import mfaRoutes from './mfa.routes';
import { isSealed, openSecret } from '@ln-system/shared/utils/secret-box';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mfa', mfaRoutes);
  return app;
}
const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
  verifyAccessTokenMock.mockReturnValue({ userId: 'user-1', email: 'u@test.local', userType: 'MANAGER', companyId: 'company-A' });
  generateSecretMock.mockReturnValue({ secret: 'NEWSECRET', qrCode: 'data:qr', backupCodes: ['a', 'b'] });
  updateMock.mockResolvedValue({});
});

describe('POST /api/mfa/setup', () => {
  it('com o MFA já ativo: 409 e o segredo gravado NÃO é sobrescrito', async () => {
    findUniqueMock.mockResolvedValue({ mfaEnabled: true });

    const res = await request(app).post('/api/mfa/setup').set('Authorization', 'Bearer t');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/MFA já está ativo/);
    expect(updateMock).not.toHaveBeenCalled();
    expect(generateSecretMock).not.toHaveBeenCalled();
  });

  it('sem MFA ativo: gera e grava o segredo (fluxo de configuração inicial continua igual)', async () => {
    findUniqueMock.mockResolvedValue({ mfaEnabled: false });

    const res = await request(app).post('/api/mfa/setup').set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ secret: 'NEWSECRET', qrCode: 'data:qr', backupCodes: ['a', 'b'] });
    expect(updateMock).toHaveBeenCalledTimes(1);
    // Gravado cifrado (secret-box), nunca em texto puro; abre idêntico.
    const stored = updateMock.mock.calls[0][0].data;
    expect(stored).toMatchObject({ mfaBackupCodes: ['hash:a', 'hash:b'] });
    expect(isSealed(stored.mfaSecret)).toBe(true);
    expect(openSecret(stored.mfaSecret)).toBe('NEWSECRET');
  });

  it('configuração iniciada e não confirmada (mfaEnabled=false) pode ser refeita', async () => {
    findUniqueMock.mockResolvedValue({ mfaEnabled: false, mfaSecret: 'OLD' });
    const res = await request(app).post('/api/mfa/setup').set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
  });
});
