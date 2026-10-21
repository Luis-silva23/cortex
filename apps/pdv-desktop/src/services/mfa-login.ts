/**
 * Regras puras da segunda etapa do login do PDV (MFA) — testadas em scripts/payment-flow.test.ts.
 */
export type MfaMethod = 'totp' | 'backup';

/** Normaliza o que o operador digitou: TOTP só dígitos (6); recuperação 16 caracteres hexadecimais. */
export function normalizeMfaCode(method: MfaMethod, input: string): string {
  return method === 'totp' ? input.replace(/\D/g, '').slice(0, 6) : input.replace(/[^0-9a-fA-F]/g, '').slice(0, 16).toLowerCase();
}

export function isMfaCodeComplete(method: MfaMethod, code: string): boolean {
  return method === 'totp' ? /^\d{6}$/.test(code) : /^[0-9a-f]{16}$/.test(code);
}

/** Erro de /auth/verify-mfa → mensagem em PT-BR e se o desafio ainda vale (senão volta ao ID/senha). */
export function mfaErrorMessage(error: any, method: MfaMethod): { message: string; restart: boolean } {
  if (!error?.response) return { message: 'Sem conexão com o servidor — o login NÃO foi concluído. Verifique a rede e tente de novo.', restart: false };
  const status = error.response.status;
  const data = error.response.data ?? {};
  const raw = String(data.message || data.error || '');
  if (status === 401) {
    return { message: 'A verificação expirou. Entre de novo com ID e senha e digite um código novo.', restart: true };
  }
  if (status === 429) return { message: raw || 'Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.', restart: false };
  if (status === 409) return { message: raw || 'Este usuário já está conectado em outro PDV.', restart: true };
  if (method === 'backup') {
    return { message: 'Código de recuperação inválido ou já usado. Cada código de recuperação vale uma única vez.', restart: false };
  }
  return {
    message: 'Código incorreto. Digite o código que aparece AGORA no aplicativo autenticador (ele muda a cada 30 segundos) e confira se a hora deste computador está certa.',
    restart: false,
  };
}
