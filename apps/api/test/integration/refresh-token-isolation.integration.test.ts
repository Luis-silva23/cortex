import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { hashRefreshToken } from '../../src/services/refresh-token-hash';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * REFRESH TOKENS (Postgres e Redis reais, papel da aplicação com RLS) — achado D-01 da revisão do banco.
 * Antes: o token ficava EM TEXTO na coluna `token`; `companyId` era nulo em 100% das linhas e a policy aceitava `companyId IS NULL`, então
 * uma sessão de EMPRESA enxergava (e poderia alterar ou apagar) as sessões de todas as empresas e as do Super Admin.
 * Agora: só o SHA-256 do token é guardado; `companyId` é o do usuário; a RLS isola por empresa (plataforma só o Super Admin); a FK composta
 * (companyId, userId) → users(companyId, id) impede gravar a sessão de um usuário em empresa que não é a dele.
 */
const asCompany = <T>(companyId: string, fn: () => Promise<T>) => runWithRLSContext({ companyId, userType: 'COMPANY_ADMIN', branchId: null }, fn);
const asPlatform = <T>(fn: () => Promise<T>) => runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, fn);

describe('refresh_tokens: hash em repouso, empresa preenchida e isolamento por RLS (integração real)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const PASSWORD = `Forte-${Date.now()}-Xk!`;
  const extraUsers: string[] = [];
  let emailA: string;
  let loginUserId: string;
  let loginRefresh: string;
  let rowA: { id: string; tokenHash: string; companyId: string | null };
  let platformUserId: string;
  let platformTokenId: string;

  beforeAll(async () => {
    A = await createFixture('rtisoA');
    B = await createFixture('rtisoB');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    await resetAuthLimits();
    // usuário próprio da empresa A, com senha conhecida (o da fixture não é para login por HTTP)
    emailA = `rtiso-a-${stamp}@teste-cortex.local`;
    const loginPassword = await hashPassword(PASSWORD);
    const loginUser = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Login sintético A', email: emailA, password: loginPassword, userType: 'MANAGER', isActive: true } })
    );
    loginUserId = loginUser.id;
    extraUsers.push(loginUser.id);
    const platformPassword = await hashPassword(`Forte-${stamp}-Xk!`);
    const platform = await bypass<any>(() =>
      db.user.create({ data: { companyId: null, name: 'Plataforma sintética', email: `rtiso-plat-${stamp}@teste-cortex.local`, password: platformPassword, userType: 'SUPER_ADMIN', isActive: true } })
    );
    platformUserId = platform.id;
    extraUsers.push(platform.id);
  });

  afterAll(async () => {
    auditSpy.mockRestore();
    await resetAuthLimits();
    if (extraUsers.length) {
      await bypass(() => db.refreshToken.deleteMany({ where: { userId: { in: extraUsers }, OR: [{ companyId: null }, { companyId: A.companyId }] } }));
      await bypass(() => db.user.deleteMany({ where: { id: { in: extraUsers }, OR: [{ companyId: null }, { companyId: A.companyId }] } }));
    }
    if (A) await destroyFixture(A);
    if (B) await destroyFixture(B);
  });

  it('estrutura: a coluna "token" não existe; tokenHash é NOT NULL, único e tem 64 hex; FKs e policy da empresa', async () => {
    const r = await bypass<any[]>(() =>
      db.$queryRawUnsafe(`
        SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'refresh_tokens' AND column_name = 'token') AS tem_token,
               (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'refresh_tokens'::regclass AND attname = 'tokenHash') AS hash_not_null,
               (SELECT count(*)::int FROM pg_indexes WHERE tablename = 'refresh_tokens' AND indexname = 'refresh_tokens_tokenHash_key' AND indexdef LIKE 'CREATE UNIQUE%') AS hash_unico,
               (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'refresh_tokens'::regclass AND conname = 'refresh_tokens_companyId_userId_fkey') AS fk_composta,
               (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'refresh_tokens'::regclass AND conname = 'refresh_tokens_companyId_fkey') AS fk_empresa,
               (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'refresh_tokens'::regclass AND polname = 'refresh_tokens_isolation') AS usando`)
    );
    expect(r[0].tem_token).toBe(0);
    expect(r[0].hash_not_null).toBe(true);
    expect(r[0].hash_unico).toBe(1);
    expect(r[0].fk_composta).toBe(1);
    expect(r[0].fk_empresa).toBe(1);
    // a policy isola SÓ por empresa (sem ramo "IS NULL"); desde a migração 20261017100000 usa o helper verificado na forma rápida (sub-select)
    expect(r[0].usando).toContain('app_ctx.company_id()');
    expect(r[0].usando).toContain('app_ctx.is_super_admin()');
    expect(r[0].usando).not.toMatch(/IS NULL/i);
    // nenhuma linha com hash fora do formato nem usuário de empresa com sessão sem empresa
    const bad = await bypass<any[]>(() =>
      db.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM refresh_tokens WHERE "tokenHash" !~ '^[0-9a-f]{64}$')
                            + (SELECT count(*)::int FROM refresh_tokens rt JOIN users u ON u.id = rt."userId" WHERE u."companyId" IS NOT NULL AND rt."companyId" IS NULL) AS n`)
    );
    expect(bad[0].n).toBe(0);
  });

  it('login real: grava o HASH do token e a empresa do usuário; o token em texto não existe em nenhuma coluna; a renovação por hash funciona', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: emailA, password: PASSWORD });
    expect(res.status).toBe(200);
    loginRefresh = res.body.refreshToken as string;
    expect(typeof loginRefresh).toBe('string');
    const row = await bypass<any>(() => db.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(loginRefresh) } }));
    expect(row).toBeTruthy();
    expect(row.companyId).toBe(A.companyId);
    expect(row.userId).toBe(loginUserId);
    rowA = row;
    const leak = await bypass<any[]>(() => db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM refresh_tokens rt WHERE rt::text LIKE '%' || '${loginRefresh}' || '%'`));
    expect(leak[0].n).toBe(0);

    const renewed = await request(app).post('/api/auth/refresh').send({ refreshToken: loginRefresh });
    expect(renewed.status).toBe(200);
    const next = renewed.body.refreshToken as string;
    expect(next).not.toBe(loginRefresh);
    const old = await bypass<any>(() => db.refreshToken.findUnique({ where: { id: rowA.id } }));
    expect(old.isRevoked).toBe(true);
    const fresh = await bypass<any>(() => db.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(next) } }));
    expect(fresh.companyId).toBe(A.companyId);
    const leak2 = await bypass<any[]>(() => db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM refresh_tokens rt WHERE rt::text LIKE '%' || '${next}' || '%'`));
    expect(leak2[0].n).toBe(0);
  });

  it('um token que não existe (nem em hash) é recusado; o hash de um token não serve como token', async () => {
    const bogus = await request(app).post('/api/auth/refresh').send({ refreshToken: 'nao-existe-' + stamp });
    expect(bogus.status).toBe(401);
    const stored = await bypass<any>(() => db.refreshToken.findFirst({ where: { companyId: A.companyId, isRevoked: false }, select: { tokenHash: true } }));
    const withHash = await request(app).post('/api/auth/refresh').send({ refreshToken: stored.tokenHash });
    expect(withHash.status).toBe(401);
  });

  it('RLS: a empresa B NÃO enxerga, não altera e não apaga as sessões da empresa A', async () => {
    const seen = await asCompany(B.companyId, () => prisma.refreshToken.findMany({ where: { companyId: A.companyId } }));
    expect(seen).toHaveLength(0);
    const seenById = await asCompany(B.companyId, () => prisma.refreshToken.findMany({ where: { id: rowA.id } }));
    expect(seenById).toHaveLength(0);
    const upd = await asCompany(B.companyId, () => prisma.refreshToken.updateMany({ where: { id: rowA.id }, data: { isRevoked: true } }));
    expect(upd.count).toBe(0);
    const del = await asCompany(B.companyId, () => prisma.refreshToken.deleteMany({ where: { id: rowA.id } }));
    expect(del.count).toBe(0);
    expect(await bypass<any>(() => db.refreshToken.findUnique({ where: { id: rowA.id } }))).toBeTruthy();
    // a própria empresa enxerga as suas
    const own = await asCompany(A.companyId, () => prisma.refreshToken.findMany({ where: { id: rowA.id } }));
    expect(own).toHaveLength(1);
  });

  it('RLS: nenhuma sessão de plataforma (companyId nulo) é visível, alterável ou apagável por uma empresa; o Super Admin as enxerga', async () => {
    const tk = await asPlatform(() =>
      prisma.refreshToken.create({ data: { userId: platformUserId, companyId: null, tokenHash: hashRefreshToken(`plat-${stamp}`), expiresAt: new Date(Date.now() + 3600_000) } })
    );
    platformTokenId = tk.id;
    expect(await asCompany(A.companyId, () => prisma.refreshToken.findMany({ where: { id: platformTokenId } }))).toHaveLength(0);
    // nenhuma linha de companyId nulo é visível a uma sessão de empresa (antes: todas)
    const nullSeen = await asCompany(A.companyId, () => prisma.refreshToken.count({ where: { companyId: null } }));
    expect(nullSeen).toBe(0);
    const upd = await asCompany(A.companyId, () => prisma.refreshToken.updateMany({ where: { id: platformTokenId }, data: { isRevoked: true } }));
    expect(upd.count).toBe(0);
    const del = await asCompany(A.companyId, () => prisma.refreshToken.deleteMany({ where: { id: platformTokenId } }));
    expect(del.count).toBe(0);
    expect(await asPlatform(() => prisma.refreshToken.findMany({ where: { id: platformTokenId } }))).toHaveLength(1);
  });

  it('RLS (escrita): a empresa B não consegue gravar sessão em nome da empresa A nem sessão de plataforma', async () => {
    await expect(
      asCompany(B.companyId, () => prisma.refreshToken.create({ data: { userId: B.userId, companyId: A.companyId, tokenHash: hashRefreshToken(`x1-${stamp}`), expiresAt: new Date(Date.now() + 3600_000) } }))
    ).rejects.toBeTruthy();
    await expect(
      asCompany(B.companyId, () => prisma.refreshToken.create({ data: { userId: B.userId, companyId: null, tokenHash: hashRefreshToken(`x2-${stamp}`), expiresAt: new Date(Date.now() + 3600_000) } }))
    ).rejects.toBeTruthy();
    const leaked = await bypass<any[]>(() => db.refreshToken.findMany({ where: { tokenHash: { in: [hashRefreshToken(`x1-${stamp}`), hashRefreshToken(`x2-${stamp}`)] } } }));
    expect(leaked).toHaveLength(0);
  });

  it('FK composta: a sessão de um usuário da empresa A não pode ser gravada com a empresa B (nem por quem ignora a RLS)', async () => {
    await expect(
      bypass(() => db.refreshToken.create({ data: { userId: A.userId, companyId: B.companyId, tokenHash: hashRefreshToken(`x3-${stamp}`), expiresAt: new Date(Date.now() + 3600_000) } }))
    ).rejects.toThrow(/foreign key|violates|restrição de chave/i);
    expect(await bypass<any[]>(() => db.refreshToken.findMany({ where: { tokenHash: hashRefreshToken(`x3-${stamp}`) } }))).toHaveLength(0);
  });
});
