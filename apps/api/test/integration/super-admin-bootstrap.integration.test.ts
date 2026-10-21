import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import {
  applySuperAdminBootstrap,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  planSuperAdminBootstrap,
  passwordProblem,
} from '../../src/services/super-admin-bootstrap.service';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * BOOTSTRAP DO SUPER ADMIN DE TI + MFA OBRIGATÓRIO PARA CONTA PRIVILEGIADA (integração real).
 * Prova: recusa sem elevar outra conta, idempotência, senha só como hash, identificador de login (até 6 dígitos) sem colisão,
 * segredo TOTP cifrado em repouso, MFA só liga com código válido, auditoria sem segredo, e o login do Super Admin sem MFA
 * barrado quando a política está ligada (e só depois da senha certa).
 */
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

describe('Bootstrap do Super Admin e MFA obrigatório (integração real)', () => {
  let A: IntegrationFixture;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = Date.now();
  const created: string[] = [];
  const STRONG = `Forte-${stamp}-Xk!`;
  const freeId = () => 900_000 + Math.floor(Math.random() * 99_000);
  const email = (label: string) => `sa-${label}-${stamp}@teste-cortex.local`;
  const track = async (e: string) => {
    const u = await bypass<any>(() => db.user.findUnique({ where: { email: e } }));
    if (u) created.push(u.id);
    return u;
  };

  beforeAll(async () => {
    A = await createFixture('sabootstrap');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    await resetAuthLimits(); // balde de falhas de login do IP é compartilhado entre as suítes (ver helper)
  });

  afterAll(async () => {
    delete process.env.REQUIRE_MFA_PRIVILEGED;
    auditSpy.mockRestore();
    await resetAuthLimits();
    await bypass(() => db.refreshToken.deleteMany({ where: { userId: { in: created }, companyId: null } }));
    await bypass(() => db.user.deleteMany({ where: { id: { in: created } } }));
    if (A?.companyId) await destroyFixture(A);
  });

  it('política de senha: curta, comum, sem variedade ou contendo o nome/e-mail é recusada', () => {
    expect(passwordProblem('Curta1!', 'a@b.co', 'Fulano de Tal')).toMatch(/12 caracteres/);
    expect(passwordProblem('somentesminusculas', 'a@b.co', 'Fulano de Tal')).toMatch(/3 tipos/);
    expect(passwordProblem('Fulano-Forte-123!', 'x@y.co', 'Fulano de Tal')).toMatch(/nome/);
    expect(passwordProblem('Joaquim-Forte-123!', 'joaquim@y.co', 'Maria Souza')).toMatch(/e-mail/);
    expect(passwordProblem(STRONG, 'x@y.co', 'Maria Souza')).toBeNull();
  });

  it('plano: entrada inválida é recusada sem tocar no banco', async () => {
    expect((await planSuperAdminBootstrap({ email: 'sem-arroba', name: 'Maria Souza' })) as any).toMatchObject({ action: 'refuse', code: 'EMAIL_INVALID' });
    expect((await planSuperAdminBootstrap({ email: email('x'), name: 'Maria' })) as any).toMatchObject({ action: 'refuse', code: 'NAME_INVALID' });
    for (const bad of [0, -1, 1_000_000, 12.5]) {
      expect((await planSuperAdminBootstrap({ email: email('x'), name: 'Maria Souza', numericId: bad })) as any).toMatchObject({ action: 'refuse', code: 'NUMERIC_ID_INVALID' });
    }
  });

  it('NÃO promove outra conta: e-mail de operador existente é recusado e o tipo continua OPERATOR', async () => {
    const hashed = await hashPassword(STRONG);
    const op = await bypass<any>(() =>
      db.user.create({ data: { companyId: A.companyId, branchId: A.branchId, name: 'Operador Existente', email: email('op'), password: hashed, userType: 'OPERATOR', isActive: true } })
    );
    created.push(op.id);
    const plan = await planSuperAdminBootstrap({ email: email('op'), name: 'Operador Existente' });
    expect(plan).toMatchObject({ action: 'refuse', code: 'EMAIL_BELONGS_TO_OTHER_ROLE' });
    await expect(applySuperAdminBootstrap({ email: email('op'), name: 'Operador Existente', password: STRONG })).rejects.toThrow(/EMAIL_BELONGS_TO_OTHER_ROLE/);
    expect((await bypass<any>(() => db.user.findUnique({ where: { id: op.id } }))).userType).toBe('OPERATOR');
  });

  it('identificador de login já usado por outra pessoa → recusa, nunca escolhe outro por conta própria', async () => {
    const other = await bypass<any>(() => db.user.findFirst({ where: { companyId: A.companyId }, select: { numericId: true } }));
    const plan = await planSuperAdminBootstrap({ email: email('id'), name: 'Maria Souza', numericId: other.numericId });
    expect(plan).toMatchObject({ action: 'refuse', code: 'NUMERIC_ID_TAKEN' });
  });

  it('cria o Super Admin: só hash de senha, id de login pedido, sem MFA ainda, auditado sem segredo; senha fraca recusada', async () => {
    const wanted = freeId();
    await expect(applySuperAdminBootstrap({ email: email('new'), name: 'Maria Souza Admin', numericId: wanted, password: 'fraca' })).rejects.toThrow(/PASSWORD_WEAK/);
    expect(await track(email('new'))).toBeNull(); // nada foi criado

    const user = await applySuperAdminBootstrap({ email: email('new'), name: 'Maria Souza Admin', numericId: wanted, password: STRONG });
    expect(user.numericId).toBe(wanted);
    const row = await track(email('new'));
    expect(row).toMatchObject({ userType: 'SUPER_ADMIN', companyId: null, mfaEnabled: false, isActive: true });
    expect(row.password).not.toContain(STRONG);
    expect(row.password.startsWith('$argon2id$')).toBe(true); // Argon2id (decisão 121)

    const audit = await bypass<any[]>(() => db.auditLog.findMany({ where: { entity: 'User', entityId: row.id } }));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const blob = JSON.stringify(audit);
    expect(blob).not.toContain(STRONG);
    expect(blob).not.toMatch(/password|secret/i);
  });

  it('idempotente: repetir não altera nada (noop) e a aplicação recusa', async () => {
    const before = await bypass<any>(() => db.user.findUnique({ where: { email: email('new') } }));
    const plan = await planSuperAdminBootstrap({ email: email('new'), name: 'Maria Souza Admin' });
    expect(plan).toMatchObject({ action: 'noop', reason: 'ALREADY_SUPER_ADMIN', mfaEnabled: false });
    await expect(applySuperAdminBootstrap({ email: email('new'), name: 'Maria Souza Admin', password: STRONG })).rejects.toThrow(/ALREADY_SUPER_ADMIN/);
    const after = await bypass<any>(() => db.user.findUnique({ where: { email: email('new') } }));
    expect(after.password).toBe(before.password);
    expect(after.numericId).toBe(before.numericId);
  });

  it('política ligada: Super Admin SEM MFA não entra (403 MFA_ENROLLMENT_REQUIRED) — só depois da senha certa; política desligada → entra', async () => {
    process.env.REQUIRE_MFA_PRIVILEGED = 'true';
    const wrong = await request(app).post('/api/auth/login').send({ email: email('new'), password: 'senha-errada-qualquer' });
    expect(wrong.status).toBe(401); // não revela o motivo a quem não sabe a senha
    const blocked = await request(app).post('/api/auth/login').send({ email: email('new'), password: STRONG });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(JSON.stringify(blocked.body)).not.toMatch(/accessToken|refreshToken/);

    process.env.REQUIRE_MFA_PRIVILEGED = 'false';
    const open = await request(app).post('/api/auth/login').send({ email: email('new'), password: STRONG });
    expect(open.status).toBe(200);
    delete process.env.REQUIRE_MFA_PRIVILEGED;
  });

  it('MFA: segredo cifrado em repouso; código errado NÃO liga; código certo liga; depois o login pede o segundo fator', async () => {
    const row = await track(email('new'));
    const begun = await beginMfaEnrollment(row.numericId);
    expect(begun.secret).toMatch(/^[A-Z2-7]+$/);
    expect(begun.backupCodes.length).toBeGreaterThanOrEqual(8);
    const stored = await bypass<any>(() => db.user.findUnique({ where: { id: row.id } }));
    expect(stored.mfaEnabled).toBe(false);
    expect(String(stored.mfaSecret).startsWith('enc:v1')).toBe(true);
    expect(String(stored.mfaSecret)).not.toContain(begun.secret);
    expect(stored.mfaBackupCodes.every((h: string) => !begun.backupCodes.includes(h))).toBe(true); // só hashes

    await expect(confirmMfaEnrollment(row.numericId, '000000', begun.secret)).rejects.toThrow(/INVALID_CODE/);
    expect((await bypass<any>(() => db.user.findUnique({ where: { id: row.id } }))).mfaEnabled).toBe(false);

    await confirmMfaEnrollment(row.numericId, totp(begun.secret), begun.secret);
    expect((await bypass<any>(() => db.user.findUnique({ where: { id: row.id } }))).mfaEnabled).toBe(true);

    process.env.REQUIRE_MFA_PRIVILEGED = 'true';
    const login = await request(app).post('/api/auth/login').send({ email: email('new'), password: STRONG });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.accessToken).toBeUndefined();
    delete process.env.REQUIRE_MFA_PRIVILEGED;
  });

  it('enrolamento é só para Super Admin e não troca o segredo com o MFA já ativo', async () => {
    const row = await track(email('new'));
    await expect(beginMfaEnrollment(row.numericId)).rejects.toThrow(/MFA_ALREADY_ENABLED/);
    const op = await track(email('op'));
    await expect(beginMfaEnrollment(op.numericId)).rejects.toThrow(/NOT_SUPER_ADMIN/);
  });
});
