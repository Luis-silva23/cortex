import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { generateAccessToken, generateDeviceCredential, generateMfaPendingToken, generateRefreshToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * CONFUSÃO DE TOKENS (Fase 4): só um ACCESS token de usuário abre as rotas. A credencial do dispositivo do PDV (10 anos, mesma chave de
 * assinatura), o token de MFA pendente, o refresh token e qualquer JWT sem identidade de usuário NÃO podem valer como sessão.
 */
describe('só access token de usuário autentica', () => {
  let A: IntegrationFixture;
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  app.use(errorHandler);

  beforeAll(async () => {
    A = await createFixture('tkn');
  }, 60000);
  afterAll(async () => {
    await destroyFixture(A);
  }, 60000);

  const SECRET = process.env.JWT_SECRET as string;
  const PATHS = ['/api/products', '/api/customers', '/api/sales', '/api/stock/movements', '/api/dashboard/pdv'];
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const expectRejected = async (token: string) => {
    for (const p of PATHS) {
      const r = await request(app).get(p).set(bearer(token));
      expect([p, r.status]).toEqual([p, 401]);
    }
  };

  it('um access token legítimo continua funcionando (controle)', async () => {
    const ok = generateAccessToken({ userId: A.userId, email: 'x@test.local', companyId: A.companyId, branchId: A.branchId, userType: 'COMPANY_ADMIN' });
    expect((await request(app).get('/api/products').set(bearer(ok))).status).toBe(200);
  });

  it('credencial de dispositivo do PDV (companyId + deviceId, sem usuário) NÃO é sessão', async () => {
    await expectRejected(generateDeviceCredential({ deviceId: 'dev-1', licenseId: 'lic-1', companyId: A.companyId }));
  });

  it('token de MFA pendente NÃO é sessão', async () => {
    await expectRejected(generateMfaPendingToken({ userId: A.userId, email: 'x@test.local' }));
  });

  it('refresh token NÃO é access token', async () => {
    await expectRejected(generateRefreshToken({ userId: A.userId, tokenId: 'tok-1' }));
  });

  it('JWT assinado com a chave certa mas sem identidade de usuário (sem userId, ou sem userType) é recusado', async () => {
    await expectRejected(jwt.sign({ companyId: A.companyId, userType: 'COMPANY_ADMIN' }, SECRET, { expiresIn: '5m' }));
    await expectRejected(jwt.sign({ userId: A.userId, companyId: A.companyId }, SECRET, { expiresIn: '5m' }));
  });

  it('chave errada, algoritmo "none", token expirado e lixo são recusados', async () => {
    const claims = { userId: A.userId, companyId: A.companyId, userType: 'COMPANY_ADMIN' };
    await expectRejected(jwt.sign(claims, 'outra-chave-qualquer-0123456789-0123456789', { expiresIn: '5m' }));
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.`;
    await expectRejected(none);
    await expectRejected(jwt.sign(claims, SECRET, { expiresIn: -10 }));
    await expectRejected('isto.nao.e-jwt');
  });

  it('o token não pode trocar de empresa: o companyId do token é o que vale (outra empresa não é alcançada pela consulta)', async () => {
    const ok = generateAccessToken({ userId: A.userId, email: 'x@test.local', companyId: A.companyId, branchId: A.branchId, userType: 'COMPANY_ADMIN' });
    const r = await request(app).get('/api/products?companyId=00000000-0000-0000-0000-000000000000').set(bearer(ok));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('00000000-0000-0000-0000-000000000000');
  });
});
