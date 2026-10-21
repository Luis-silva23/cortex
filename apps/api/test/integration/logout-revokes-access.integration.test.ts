import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Logout encerra a sessão de verdade (jornada real do PDV): o logout só revogava o refresh token, e o access token
 * do operador que saiu seguia aceito até expirar (15 min) — quem pegasse o token continuava operando o caixa.
 * O token apresentado no logout fica recusado até a expiração; as outras sessões do mesmo usuário seguem valendo.
 */
describe('Logout revoga o access token apresentado (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const tokenOf = () =>
    generateAccessToken({ userId: fixture.userId, email: 'op@test.local', companyId: fixture.companyId, branchId: fixture.branchId, userType: 'OPERATOR' });
  const me = (token: string) => request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    fixture = await createFixture('logoutrev');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (fixture) await destroyFixture(fixture);
  });

  it('o token do logout deixa de valer; outra sessão do mesmo usuário continua', async () => {
    const pdv = tokenOf();
    const other = tokenOf();
    expect(pdv).not.toBe(other);
    expect((await me(pdv)).status).toBe(200);

    const out = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${pdv}`).send({ refreshToken: 'sem-registro' });
    expect(out.status).toBe(200);

    expect((await me(pdv)).status).toBe(401);
    expect((await me(other)).status).toBe(200);
  });
});
