/**
 * POLÍTICA DE MFA OBRIGATÓRIO por perfil (decisão 123, 2026-10-14).
 *  - SUPER_ADMIN: `REQUIRE_MFA_PRIVILEGED`; enrolamento ADMINISTRATIVO (`npm run admin:bootstrap -- enroll-mfa`).
 *  - COMPANY_ADMIN: `REQUIRE_MFA_COMPANY_ADMIN`; enrolamento PELA TELA no primeiro login (credencial de configuração de 10 min).
 * Padrão: obrigatório em produção; fora dela os ambientes de desenvolvimento/teste seguem como antes. `true`/`false` força, mas a
 * partida da API RECUSA `false` em produção (config/env.ts). A exigência vale pelo perfil ATUAL do usuário em cada login e em cada
 * renovação: promover alguém a COMPANY_ADMIN não o isenta, e rebaixar/promover não preserva sessão antiga (sessões são revogadas).
 */
const flag = (raw: string | undefined): boolean | undefined => {
  const v = raw?.trim().toLowerCase();
  return v === 'true' ? true : v === 'false' ? false : undefined;
};

export function mfaRequiredForPrivileged(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.REQUIRE_MFA_PRIVILEGED) ?? env.NODE_ENV === 'production';
}

export function mfaRequiredForCompanyAdmin(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.REQUIRE_MFA_COMPANY_ADMIN) ?? env.NODE_ENV === 'production';
}

export function mfaRequiredForUserType(userType: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (userType === 'SUPER_ADMIN') return mfaRequiredForPrivileged(env);
  if (userType === 'COMPANY_ADMIN') return mfaRequiredForCompanyAdmin(env);
  return false;
}

/** Perfis cujo enrolamento acontece pela tela (os demais exigidos fazem pelo procedimento administrativo). */
export const SELF_ENROLLMENT_USER_TYPES = ['COMPANY_ADMIN'] as const;
