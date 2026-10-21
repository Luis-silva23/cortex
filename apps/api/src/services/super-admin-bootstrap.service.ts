import { AuditAction, prisma, runWithRLSContext } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { sealSecret } from '@ln-system/shared/utils/secret-box';
import { normalizeEmail } from '@ln-system/shared/utils/email';
import { mfaService } from './MFAService';
import { resetFactor } from './mfa-factor.service';

/**
 * BOOTSTRAP DA CONTA SUPER ADMIN DE TI (e enrolamento de MFA).
 *
 * Nenhuma rota HTTP cria o primeiro Super Admin (só um Super Admin cria outro): é uma operação ADMINISTRATIVA, feita por
 * quem tem acesso ao servidor/banco, pelo CLI `scripts/bootstrap-super-admin.ts`. Este serviço é a lógica, testável:
 *
 *  - NUNCA recebe nem grava senha fixa/padrão: a senha vem do operador (variável de ambiente ou prompt oculto) e só o hash
 *    (Argon2id, o mesmo algoritmo do login) chega ao banco. Nada de senha em log, auditoria ou resposta.
 *  - IDEMPOTENTE e sem elevação: e-mail que já é Super Admin = "nada a fazer"; e-mail que pertence a OUTRO perfil = RECUSA
 *    (nunca promove ninguém em silêncio); identificador numérico já usado por outra pessoa = RECUSA (nunca escolhe outro).
 *  - Identificador de login: `numericId` (único, até 6 dígitos). O `id` técnico é o UUID e não se confunde com ele.
 *  - MFA: o segredo TOTP é gerado, cifrado em repouso (`enc:v1`) e só passa a valer depois que o operador digita um código
 *    válido (evita trancar a conta por QR mal lido). Os códigos de backup só existem em texto uma vez, na saída do CLI.
 *  - Auditoria: criação e enrolamento ficam em `audit_logs` (quem/o quê/quando; nunca segredo).
 */
export const MAX_LOGIN_ID = 999_999; // identificador de login: até 6 dígitos

export type BootstrapRefusal =
  | 'EMAIL_INVALID'
  | 'NAME_INVALID'
  | 'NUMERIC_ID_INVALID'
  | 'NUMERIC_ID_TAKEN'
  | 'EMAIL_BELONGS_TO_OTHER_ROLE';

export type BootstrapPlan =
  | { action: 'create'; email: string; name: string; numericId: number | 'auto' }
  | { action: 'noop'; reason: 'ALREADY_SUPER_ADMIN'; numericId: number; mfaEnabled: boolean; isActive: boolean }
  | { action: 'refuse'; code: BootstrapRefusal; message: string };

const COMMON_PASSWORDS = new Set(['123456789012', 'password1234', 'senha1234567', 'administrador', 'qwertyuiop12', 'abcdefghijkl', 'admin1234567', 'cortex123456']);

/** Política mínima de senha de conta privilegiada (o hash por si só não compensa senha fraca). */
export function passwordProblem(password: string, email: string, name: string): string | null {
  if (typeof password !== 'string' || password.length < 12) return 'A senha precisa ter pelo menos 12 caracteres.';
  if (password.length > 128) return 'A senha é longa demais (máximo 128 caracteres).';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Senha comum demais.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) return 'Use ao menos 3 tipos de caractere (minúscula, maiúscula, número, símbolo).';
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return 'A senha não pode conter o início do e-mail.';
  const firstName = name.trim().split(/\s+/)[0]?.toLowerCase();
  if (firstName && firstName.length >= 4 && password.toLowerCase().includes(firstName)) return 'A senha não pode conter o seu nome.';
  return null;
}

const asPlatform = <T>(fn: () => Promise<T>) => runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, fn);

/** Só lê. Diz o que o bootstrap faria e por que recusaria. */
export async function planSuperAdminBootstrap(input: { email: string; name: string; numericId?: number | null }): Promise<BootstrapPlan> {
  const email = normalizeEmail(input.email ?? '');
  const name = (input.name ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { action: 'refuse', code: 'EMAIL_INVALID', message: 'E-mail inválido.' };
  if (name.length < 5 || name.split(/\s+/).length < 2) return { action: 'refuse', code: 'NAME_INVALID', message: 'Informe o nome completo.' };
  const numericId = input.numericId ?? null;
  if (numericId !== null && (!Number.isInteger(numericId) || numericId < 1 || numericId > MAX_LOGIN_ID)) {
    return { action: 'refuse', code: 'NUMERIC_ID_INVALID', message: `O identificador de login deve ser um inteiro de 1 a ${MAX_LOGIN_ID} (até 6 dígitos).` };
  }

  return asPlatform(async (): Promise<BootstrapPlan> => {
    const byEmail = await prisma.user.findUnique({ where: { email }, select: { id: true, userType: true, numericId: true, mfaEnabled: true, isActive: true } });
    if (byEmail) {
      if (byEmail.userType === 'SUPER_ADMIN') {
        return { action: 'noop', reason: 'ALREADY_SUPER_ADMIN', numericId: byEmail.numericId, mfaEnabled: byEmail.mfaEnabled, isActive: byEmail.isActive };
      }
      return {
        action: 'refuse',
        code: 'EMAIL_BELONGS_TO_OTHER_ROLE',
        message: `Este e-mail já pertence a uma conta ${byEmail.userType}. Nenhuma conta é promovida automaticamente: resolva isto manualmente.`,
      };
    }
    if (numericId !== null) {
      const taken = await prisma.user.findUnique({ where: { numericId }, select: { id: true } });
      if (taken) return { action: 'refuse', code: 'NUMERIC_ID_TAKEN', message: `O identificador ${numericId} já é de outra pessoa. Nada foi alterado.` };
    }
    return { action: 'create', email, name, numericId: numericId ?? 'auto' };
  });
}

/** Cria a conta. Recusa por si só (não depende de o chamador ter feito o plano). A senha nunca é devolvida. */
export async function applySuperAdminBootstrap(input: { email: string; name: string; numericId?: number | null; password: string; via?: string }) {
  const plan = await planSuperAdminBootstrap(input);
  if (plan.action !== 'create') throw new Error(plan.action === 'refuse' ? `${plan.code}: ${plan.message}` : 'ALREADY_SUPER_ADMIN: a conta já existe; nada foi alterado.');
  const problem = passwordProblem(input.password, plan.email, plan.name);
  if (problem) throw new Error(`PASSWORD_WEAK: ${problem}`);
  const hashed = await hashPassword(input.password);

  return asPlatform(async () => {
    const user = await prisma.user.create({
      data: {
        name: plan.name,
        email: plan.email,
        password: hashed,
        userType: 'SUPER_ADMIN',
        companyId: null,
        branchId: null,
        isActive: true,
        emailVerified: true,
        mfaEnabled: false, // só passa a true depois do enrolamento confirmado com um código (enrollMfa)
        ...(plan.numericId === 'auto' ? {} : { numericId: plan.numericId }),
      },
      select: { id: true, numericId: true, email: true, name: true },
    });
    await prisma.auditLog.create({
      data: {
        companyId: null,
        userId: null,
        action: AuditAction.CREATE,
        entity: 'User',
        entityId: user.id,
        newValue: JSON.stringify({ userType: 'SUPER_ADMIN', numericId: user.numericId, mfaEnabled: false, via: input.via ?? 'bootstrap-cli' }),
        ipAddress: 'cli',
        userAgent: 'bootstrap-super-admin',
      },
    });
    return user;
  });
}

/** Passo 1 do MFA: gera o segredo, grava CIFRADO e os hashes dos códigos de backup (mfaEnabled continua false). */
export async function beginMfaEnrollment(numericId: number) {
  return asPlatform(async () => {
    const user = await prisma.user.findUnique({ where: { numericId }, select: { id: true, email: true, userType: true, mfaEnabled: true } });
    if (!user) throw new Error('USER_NOT_FOUND');
    if (user.userType !== 'SUPER_ADMIN') throw new Error('NOT_SUPER_ADMIN: este procedimento é só para Super Admin.');
    if (user.mfaEnabled) throw new Error('MFA_ALREADY_ENABLED: desative-o antes (com a senha) para trocar o segredo.');
    const data = mfaService.generateSecret(user.id, user.email);
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: sealSecret(data.secret), mfaBackupCodes: data.backupCodes.map((c) => mfaService.hashBackupCode(c)), mfaEnabled: false },
    });
    return { userId: user.id, email: user.email, secret: data.secret, otpauthUrl: data.qrCode, backupCodes: data.backupCodes };
  });
}

/**
 * RECUPERAÇÃO administrativa (perda do aplicativo autenticador do Super Admin): apaga segredo e códigos de recuperação, derruba as
 * sessões e audita. Depois, `enroll-mfa` configura de novo. Só roda no servidor (acesso ao banco), nunca por rota HTTP.
 */
export async function resetMfa(numericId: number) {
  return asPlatform(async () => {
    const user = await prisma.user.findUnique({ where: { numericId }, select: { id: true, userType: true } });
    if (!user) throw new Error('USER_NOT_FOUND');
    if (user.userType !== 'SUPER_ADMIN') throw new Error('NOT_SUPER_ADMIN: para contas de empresa use a reinicialização pela API (Super Admin autenticado).');
    await resetFactor(user.id);
    await prisma.auditLog.create({
      data: {
        companyId: null,
        userId: null,
        action: AuditAction.UPDATE,
        entity: 'UserMfa',
        entityId: user.id,
        newValue: JSON.stringify({ operation: 'MFA_RESET', via: 'bootstrap-cli' }),
        ipAddress: 'cli',
        userAgent: 'bootstrap-super-admin',
      },
    });
    return user;
  });
}

/** Passo 2: só liga o MFA se o código TOTP informado confere com o segredo gerado no passo 1. */
export async function confirmMfaEnrollment(numericId: number, code: string, secret: string) {
  if (!mfaService.verifyCode(secret, code).valid) throw new Error('INVALID_CODE: o código não confere; o MFA NÃO foi ativado.');
  return asPlatform(async () => {
    const user = await prisma.user.update({ where: { numericId }, data: { mfaEnabled: true }, select: { id: true } });
    await prisma.auditLog.create({
      data: {
        companyId: null,
        userId: null,
        action: AuditAction.UPDATE,
        entity: 'User',
        entityId: user.id,
        newValue: JSON.stringify({ mfaEnabled: true, via: 'bootstrap-cli' }),
        ipAddress: 'cli',
        userAgent: 'bootstrap-super-admin',
      },
    });
    return user;
  });
}
