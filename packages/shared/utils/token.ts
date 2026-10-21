import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type { JwtPayload } from '../types';

// Placeholder values copied verbatim from .env.example — if either secret is
// missing OR still equals the example placeholder, every token this process
// signs is either broken or forgeable by anyone who's read the example
// file. Fail at startup (import time), not on the first login request in
// production.
const JWT_SECRET_PLACEHOLDER = 'your-super-secret-jwt-key-change-this-in-production';
const JWT_REFRESH_SECRET_PLACEHOLDER = 'your-super-secret-refresh-key-change-this-in-production';
const MIN_SECRET_LENGTH = 32;

function requireStrongSecret(value: string | undefined, label: string, placeholder: string): string {
  if (!value || value === placeholder || value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${label} ausente ou fraca`);
  }
  return value;
}

const JWT_SECRET = requireStrongSecret(process.env.JWT_SECRET, 'JWT_SECRET', JWT_SECRET_PLACEHOLDER);
const JWT_REFRESH_SECRET = requireStrongSecret(
  process.env.JWT_REFRESH_SECRET,
  'JWT_REFRESH_SECRET',
  JWT_REFRESH_SECRET_PLACEHOLDER
);

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

// Same secret as the real access token on purpose (see verifyAccessToken /
// apps/api/src/middleware/auth.ts): the MFA-pending token has to be
// signature-valid under the exact same key so a leaked/forged mfaPending
// claim can't be told apart from a real one by algorithm/secret alone —
// the ONLY thing that must gate it is the explicit `mfaPending` check in
// authMiddleware and here in verifyMfaPendingToken. Short TTL is the actual
// containment.
const MFA_PENDING_EXPIRES_IN = '10m';

interface AccessTokenPayload {
  userId: string;
  email: string;
  companyId?: string;
  branchId?: string;
  userType: string;
  /** Sessão de equipamento (device_sessions.id): a API confere a cada requisição que ela e o equipamento continuam ativos. */
  dsid?: string;
}

// jwtid: cada sessão tem um token único — sem ele, dois logins do mesmo usuário no mesmo segundo geravam o mesmo
// token, e revogar um (logout) derrubava o outro.
export function generateAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, jwtid: randomUUID() } as jwt.SignOptions);
}

/**
 * SÓ um token de SESSÃO DE USUÁRIO vale como access token. Todos os JWTs assinados com `JWT_SECRET` (access, MFA pendente e a
 * credencial de 10 anos do dispositivo do PDV) passam pela assinatura; sem esta conferência de identidade, a credencial do dispositivo
 * (`companyId` + `deviceId`, sem usuário) autenticava como sessão e lia as rotas da empresa (achado da auditoria de produção,
 * 2026-10-06, provado em `token-confusion.integration.test.ts`). O algoritmo é fixado em HS256.
 */
export function verifyAccessToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload & { deviceId?: unknown; licenseId?: unknown };
  if (typeof decoded.userId !== 'string' || !decoded.userId || typeof decoded.userType !== 'string' || !decoded.userType || decoded.deviceId !== undefined || decoded.licenseId !== undefined) {
    throw new Error('Token não é um access token de usuário');
  }
  return decoded;
}

interface RefreshTokenPayload {
  userId: string;
  tokenId: string;
}

export function generateRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN } as jwt.SignOptions);
}

interface MfaPendingPayload {
  userId: string;
  email: string;
  deviceId?: string;
}

interface DecodedMfaPendingPayload extends MfaPendingPayload {
  mfaPending: true;
}

export function generateMfaPendingToken(payload: MfaPendingPayload): string {
  const claims: DecodedMfaPendingPayload = { ...payload, mfaPending: true };
  return jwt.sign(claims, JWT_SECRET, { expiresIn: MFA_PENDING_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyMfaPendingToken(token: string): MfaPendingPayload {
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as Partial<DecodedMfaPendingPayload>;

  // Mirrors the check authMiddleware does in the other direction (rejects a
  // pending token used as a full session) — here we reject the opposite: a
  // full access token (or anything else signed with this secret) being
  // replayed against the MFA-verification endpoints as if it were a
  // pending token.
  if (decoded.mfaPending !== true || !decoded.userId) {
    throw new Error('Token não é um token de verificação de MFA válido');
  }

  return { userId: decoded.userId, email: decoded.email!, deviceId: decoded.deviceId };
}

interface MfaEnrollmentPayload {
  userId: string;
  email: string;
  deviceId?: string;
}

/**
 * Credencial de CONFIGURAÇÃO do MFA (decisão 123): emitida depois da senha correta a uma conta cujo perfil exige MFA e que ainda não o
 * tem. Só abre as duas rotas de enrolamento (`/auth/mfa-enrollment/begin|confirm`): não tem `userType` (não passa como access token),
 * não tem `mfaPending` (não passa como token de verificação) e vale 10 minutos.
 */
export function generateMfaEnrollmentToken(payload: MfaEnrollmentPayload): string {
  return jwt.sign({ ...payload, mfaEnrollment: true }, JWT_SECRET, { expiresIn: MFA_PENDING_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyMfaEnrollmentToken(token: string): MfaEnrollmentPayload {
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as Partial<MfaEnrollmentPayload> & { mfaEnrollment?: boolean; mfaPending?: boolean };
  if (decoded.mfaEnrollment !== true || decoded.mfaPending || !decoded.userId) {
    throw new Error('Token não é um token de configuração de MFA válido');
  }
  return { userId: decoded.userId, email: decoded.email!, deviceId: decoded.deviceId };
}

interface PasswordChangePayload {
  userId: string;
  email: string;
}

/**
 * Credencial de TROCA DE SENHA (decisão 157): emitida depois da senha correta (e do MFA, quando a conta o tem) a quem ainda precisa trocar a senha
 * temporária. Só abre `/auth/password-change/complete`: não tem `userType` (não passa como access token), não tem `mfaPending` nem
 * `mfaEnrollment` (não passa como as outras credenciais de finalidade única) e vale 10 minutos.
 */
export function generatePasswordChangeToken(payload: PasswordChangePayload): string {
  return jwt.sign({ ...payload, passwordChange: true }, JWT_SECRET, { expiresIn: MFA_PENDING_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyPasswordChangeToken(token: string): PasswordChangePayload {
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as Partial<PasswordChangePayload> & {
    passwordChange?: boolean;
    mfaPending?: boolean;
    mfaEnrollment?: boolean;
    userType?: unknown;
  };
  if (decoded.passwordChange !== true || decoded.mfaPending || decoded.mfaEnrollment || decoded.userType !== undefined || !decoded.userId) {
    throw new Error('Token não é um token de troca de senha válido');
  }
  return { userId: decoded.userId, email: decoded.email! };
}

interface DeviceCredentialPayload {
  deviceId: string;
  licenseId: string;
  companyId: string;
}

// Long-lived on purpose: this credential is what a PDV device holds
// locally after activation to identify itself, not a session token — it
// isn't re-verified anywhere in apps/api today (verification, if any,
// belongs to whatever apps/pdv-desktop does with it locally).
export function generateDeviceCredential(payload: DeviceCredentialPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '3650d' } as jwt.SignOptions);
}
