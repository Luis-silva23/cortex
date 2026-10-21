/**
 * POLÍTICA DE SENHA ESCOLHIDA PELO PRÓPRIO USUÁRIO (decisão 157). A senha TEMPORÁRIA definida por um administrador segue o mínimo do cadastro (8 caracteres, `validators.ts`);
 * a que a pessoa escolhe é mais exigente, porque é a que fica. Devolve o motivo da recusa em português (para a tela) ou `null` se a senha é aceitável.
 *
 * Regras: 10 a 128 caracteres (o teto evita custo de hash arbitrário), ao menos uma letra e um número, diferente da senha atual, sem conter a parte local do e-mail e fora
 * de uma lista curta de senhas notoriamente fracas. Não há "força" pontuada: regras simples e verificáveis, sem prometer o que não garantem.
 */
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  'senha12345', '1234567890', '12345678910', 'password123', 'password1234', 'qwerty12345', 'qwertyuiop1', 'abc1234567', 'abcd123456', 'senha123456',
  'mudar12345', 'admin12345', 'cortex12345', 'bemvindo123', 'brasil12345', 'trocar12345', 'senhasenha1', 'q1w2e3r4t5',
]);

/** Contas privilegiadas (SUPER_ADMIN, COMPANY_ADMIN) seguem a mesma régua da criação do Super Admin (`passwordProblem`): 12 caracteres e 3 tipos. */
const PRIVILEGED_MIN_LENGTH = 12;
const PRIVILEGED_MIN_CLASSES = 3;

export function validateNewPassword(newPassword: unknown, context: { currentPassword?: string; email?: string; privileged?: boolean } = {}): string | null {
  if (typeof newPassword !== 'string') return 'Informe a nova senha.';
  if (newPassword.length < MIN_LENGTH) return `A nova senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`;
  if (context.privileged) {
    if (newPassword.length < PRIVILEGED_MIN_LENGTH) return `Contas de administrador exigem senha com pelo menos ${PRIVILEGED_MIN_LENGTH} caracteres.`;
    const classes = [/[a-zà-ÿ]/, /[A-ZÀ-Þ]/, /[0-9]/, /[^A-Za-zÀ-ÿ0-9]/].filter((rx) => rx.test(newPassword)).length;
    if (classes < PRIVILEGED_MIN_CLASSES) return 'Contas de administrador exigem ao menos 3 tipos de caractere (minúscula, maiúscula, número, símbolo).';
  }
  if (newPassword.length > MAX_LENGTH) return `A nova senha pode ter no máximo ${MAX_LENGTH} caracteres.`;
  if (!/[A-Za-zÀ-ÿ]/.test(newPassword) || !/[0-9]/.test(newPassword)) return 'A nova senha precisa ter pelo menos uma letra e um número.';
  if (context.currentPassword !== undefined && newPassword === context.currentPassword) return 'A nova senha precisa ser diferente da senha atual.';

  const lower = newPassword.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Essa senha é muito comum. Escolha outra.';
  const local = (context.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'A nova senha não pode conter o seu e-mail.';
  return null;
}
