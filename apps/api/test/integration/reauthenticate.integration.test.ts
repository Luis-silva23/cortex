import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { hashPassword } from '@ln-system/shared/utils/password';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * REAUTENTICAÇÃO (tela bloqueada do PDV Desktop): `POST /api/auth/reauthenticate` confere a senha do usuário do TOKEN e nada
 * mais. Não cria sessão, não rotaciona token, não aceita identificador (não dá para validar a senha de outra pessoa com a
 * sessão de um operador) e tentativas erradas contam no balde `authorizer` do usuário.
 */
describe('Reautenticação para desbloquear a tela (integração real)', () => {
  let A: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const created: string[] = [];
  const PASSWORD = 'Senha-Correta-123!';

  const mkUser = async (label: string, opts: { isActive?: boolean } = {}) => {
    const hashed = await hashPassword(PASSWORD);
    const u = await bypass<any>(() =>
      db.user.create({
        data: { companyId: A.companyId, branchId: A.branchId, name: `Reauth ${label}`, email: `reauth-${label}-${stamp}@test.local`, password: hashed, userType: 'OPERATOR', isActive: opts.isActive ?? true },
      })
    );
    created.push(u.id);
    return u;
  };
  const bearer = (userId: string) => ({
    Authorization: `Bearer ${generateAccessToken({ userId, email: 'op@test.local', companyId: A.companyId, branchId: A.branchId as any, userType: 'OPERATOR' })}`,
  });
  const post = (userId: string, body: object) => request(app).post('/api/auth/reauthenticate').set(bearer(userId)).send(body);

  beforeAll(async () => {
    A = await createFixture('reauth');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    if (A?.companyId) await bypass(() => db.user.deleteMany({ where: { companyId: A.companyId, id: { in: created } } }));
    if (A?.companyId) await destroyFixture(A);
  });

  it('senha correta do próprio usuário → 200, sem token novo', async () => {
    const u = await mkUser('ok');
    const r = await post(u.id, { password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);
  });

  it('senha errada → 401 WRONG_PASSWORD; sem senha → 400; senha enorme → 400', async () => {
    const u = await mkUser('wrong');
    const wrong = await post(u.id, { password: 'errada' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('WRONG_PASSWORD');
    expect((await post(u.id, {})).status).toBe(400);
    expect((await post(u.id, { password: 'x'.repeat(300) })).status).toBe(400);
  });

  it('a sessão de um operador não valida a senha de OUTRO: o campo de identificador é ignorado', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    const bHash = await hashPassword('Senha-Do-B-999!');
    await bypass(() => db.user.update({ where: { id: b.id }, data: { password: bHash } }));
    const r = await post(a.id, { password: 'Senha-Do-B-999!', userId: b.id, numericId: b.numericId, email: b.email });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('WRONG_PASSWORD');
  });

  it('sem token → 401; usuário desativado → recusado mesmo com a senha certa', async () => {
    expect((await request(app).post('/api/auth/reauthenticate').send({ password: PASSWORD })).status).toBe(401);
    const off = await mkUser('off', { isActive: false });
    const r = await post(off.id, { password: PASSWORD });
    expect([401, 403]).toContain(r.status);
  });

  it('tentativas erradas em excesso bloqueiam (429) e a senha certa também fica bloqueada durante a janela', async () => {
    const u = await mkUser('burst');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(u.id, { password: `errada-${i}` })).status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
    expect((await post(u.id, { password: PASSWORD })).status).toBe(429);
  });
});
