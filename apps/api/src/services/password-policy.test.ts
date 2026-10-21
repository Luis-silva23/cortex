import { validateNewPassword } from './password-policy';
import { generatePasswordChangeToken, verifyPasswordChangeToken, generateAccessToken, generateMfaEnrollmentToken, generateMfaPendingToken, verifyAccessToken } from '@ln-system/shared/utils/token';

describe('validateNewPassword (decisão 157)', () => {
  it('aceita uma senha de 10+ caracteres com letra e número', () => {
    expect(validateNewPassword('Cortex-2026-forte')).toBeNull();
    expect(validateNewPassword('frase longa com 7 palavras', { email: 'ana@loja.com' })).toBeNull();
  });

  it.each([
    ['curta', 'Abc12', /pelo menos 10/],
    ['sem número', 'somenteletrasaqui', /letra e um número/],
    ['sem letra', '1234567890123', /letra e um número/],
    ['igual à atual', 'Mesma-Senha-1', /diferente da senha atual/],
    ['comum', 'senha12345', /muito comum/],
  ])('recusa senha %s', (_label, value, reason) => {
    expect(validateNewPassword(value, { currentPassword: 'Mesma-Senha-1' }) ?? '').toMatch(reason);
  });

  it('recusa senha que contém a parte local do e-mail (a partir de 4 caracteres) e não implica com e-mail curto', () => {
    expect(validateNewPassword('xxmaria.silvaxx9', { email: 'maria.silva@loja.com' })).toMatch(/e-mail/);
    expect(validateNewPassword('Zz-abc-12345-ok', { email: 'abc@loja.com' })).toBeNull();
  });

  it('contas de administrador seguem a régua do Super Admin: 12 caracteres e 3 tipos; as demais não', () => {
    expect(validateNewPassword('Abcdefgh12', { privileged: true })).toMatch(/pelo menos 12/);
    expect(validateNewPassword('abcdefghijk12345', { privileged: true })).toMatch(/3 tipos/);
    expect(validateNewPassword('Abcdefghijk12345', { privileged: true })).toBeNull();
    expect(validateNewPassword('abcdefghijk1!', { privileged: true })).toBeNull();
    expect(validateNewPassword('abcdefghijk12345')).toBeNull(); // operador: 10+ com letra e número
  });

  it('limita o tamanho (teto contra custo de hash arbitrário) e recusa o que não é texto', () => {
    expect(validateNewPassword('a1'.repeat(65))).toMatch(/no máximo 128/);
    expect(validateNewPassword(undefined)).toMatch(/Informe/);
    expect(validateNewPassword({ $ne: null })).toMatch(/Informe/);
  });
});

describe('credencial de troca de senha (finalidade única)', () => {
  const who = { userId: 'u-1', email: 'u1@teste.local' };

  it('é verificável e devolve só usuário e e-mail', () => {
    expect(verifyPasswordChangeToken(generatePasswordChangeToken(who))).toEqual(who);
  });

  it('NÃO vale como access token (não tem userType) nem é aceita no lugar das outras credenciais de finalidade única', () => {
    const token = generatePasswordChangeToken(who);
    expect(() => verifyAccessToken(token)).toThrow();
    // o caminho inverso: nenhuma outra credencial vale como credencial de troca
    expect(() => verifyPasswordChangeToken(generateAccessToken({ ...who, userType: 'OPERATOR' }))).toThrow();
    expect(() => verifyPasswordChangeToken(generateMfaPendingToken(who))).toThrow();
    expect(() => verifyPasswordChangeToken(generateMfaEnrollmentToken(who))).toThrow();
  });

  it('recusa lixo e token sem a marca', () => {
    expect(() => verifyPasswordChangeToken('nao-e-um-jwt')).toThrow();
    expect(() => verifyPasswordChangeToken('')).toThrow();
  });
});
