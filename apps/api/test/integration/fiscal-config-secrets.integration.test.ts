import express from 'express';
import request from 'supertest';
import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { isSealed, openSecret } from '@ln-system/shared/utils/secret-box';
import fiscalRoutes from '../../src/routes/fiscal.routes';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';

/**
 * Segredos da configuração fiscal — prova REAL (HTTP + Postgres/RLS, sem mock;
 * JWT assinado com o segredo real do .env).
 *
 * ACHADO DE AUDITORIA (SEGURANÇA): GET/POST /fiscal/config devolviam
 * `certificatePassword` e `cscToken` em texto puro, e o POST espalhava o corpo
 * inteiro no Prisma (dava para mexer no contador interno de numeração fiscal).
 */

async function bypass<T>(query: () => any): Promise<T> {
  const [, result] = await prismaUnsafeBypassRLS.$transaction([
    contextStatement(prismaUnsafeBypassRLS, PLATFORM_CONTEXT),
    query(),
  ]);
  return result as T;
}

describe('Configuração fiscal — segredos nunca saem pela API (integração real)', () => {
  let fixture: IntegrationFixture;
  let app: express.Express;

  const tokenFor = (userType: string) =>
    generateAccessToken({
      userId: fixture.userId,
      email: `${userType.toLowerCase()}@test.local`,
      companyId: fixture.companyId,
      branchId: fixture.branchId,
      userType,
    });

  const dbRow = () =>
    bypass<any>(() =>
      prismaUnsafeBypassRLS.fiscalConfig.findFirst({ where: { companyId: fixture.companyId, branchId: fixture.branchId } })
    );

  beforeAll(async () => {
    fixture = await createFixture('fiscal-secrets');
    app = express();
    app.use(express.json());
    app.use('/api/fiscal', fiscalRoutes);
  }, 30000);

  afterAll(async () => {
    await bypass(() => prismaUnsafeBypassRLS.fiscalConfig.deleteMany({ where: { companyId: fixture.companyId } }));
    await destroyFixture(fixture);
  }, 30000);

  it('POST grava os segredos no banco mas NÃO os devolve; ignora o contador interno enviado no corpo', async () => {
    const res = await request(app)
      .post('/api/fiscal/config')
      .set('Authorization', `Bearer ${tokenFor('COMPANY_ADMIN')}`)
      .send({
        branchId: fixture.branchId,
        nfceEnabled: true,
        certificatePath: '/certs/a.pfx',
        certificatePassword: 'segredo-do-certificado',
        cscId: '1',
        cscToken: 'token-csc-secreto',
        nfceNextNumber: 999,
      });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('certificatePassword');
    expect(res.body).not.toHaveProperty('cscToken');
    expect(res.body.hasCertificatePassword).toBe(true);
    expect(res.body.hasCscToken).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('segredo-do-certificado');
    expect(JSON.stringify(res.body)).not.toContain('token-csc-secreto');

    // Cifrados em repouso (secret-box): o banco não guarda o texto, mas o valor abre idêntico para a emissão.
    const row = await dbRow();
    expect(isSealed(row.certificatePassword)).toBe(true);
    expect(isSealed(row.cscToken)).toBe(true);
    expect(row.certificatePassword).not.toContain('segredo-do-certificado');
    expect(openSecret(row.certificatePassword)).toBe('segredo-do-certificado');
    expect(openSecret(row.cscToken)).toBe('token-csc-secreto');
    expect(row.nfceNextNumber).toBe(1); // o corpo tentou 999; o contador é interno
  });

  it('GET devolve a configuração SEM segredos e com os indicadores de configurado', async () => {
    const res = await request(app)
      .get('/api/fiscal/config')
      .query({ branchId: fixture.branchId })
      .set('Authorization', `Bearer ${tokenFor('COMPANY_ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('certificatePassword');
    expect(res.body).not.toHaveProperty('cscToken');
    expect(JSON.stringify(res.body)).not.toContain('segredo-do-certificado');
    expect(JSON.stringify(res.body)).not.toContain('token-csc-secreto');
    expect(res.body.hasCertificatePassword).toBe(true);
    expect(res.body.hasCscToken).toBe(true);
    expect(res.body.certificatePath).toBe('/certs/a.pfx');
    expect(res.body.nfceEnabled).toBe(true);
  });

  it('salvar SEM reenviar o segredo (vazio/ausente) mantém o valor gravado e altera o resto', async () => {
    const res = await request(app)
      .post('/api/fiscal/config')
      .set('Authorization', `Bearer ${tokenFor('COMPANY_ADMIN')}`)
      .send({ branchId: fixture.branchId, environment: 'PRODUCAO', certificatePassword: '', cscId: '2' });

    expect(res.status).toBe(201);
    expect(res.body.hasCertificatePassword).toBe(true);

    const row = await dbRow();
    expect(openSecret(row.certificatePassword)).toBe('segredo-do-certificado');
    expect(openSecret(row.cscToken)).toBe('token-csc-secreto');
    expect(row.environment).toBe('PRODUCAO');
    expect(row.cscId).toBe('2');
  });

  it('enviar um segredo novo substitui o antigo', async () => {
    const res = await request(app)
      .post('/api/fiscal/config')
      .set('Authorization', `Bearer ${tokenFor('COMPANY_ADMIN')}`)
      .send({ branchId: fixture.branchId, cscToken: 'token-novo' });

    expect(res.status).toBe(201);
    expect(openSecret((await dbRow()).cscToken)).toBe('token-novo');
  });

  it('MANAGER continua sem acesso (403) e o GET não vaza nada', async () => {
    const res = await request(app)
      .get('/api/fiscal/config')
      .query({ branchId: fixture.branchId })
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('token-');
  });
});
