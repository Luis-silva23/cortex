import { MFAService } from './MFAService';

/**
 * ANTES DA CORREÇÃO: verifyBackupCode só validava o FORMATO do código
 * (16 caracteres) e retornava `valid: true` para qualquer string desse
 * tamanho, independente de ter sido realmente emitida para o usuário —
 * um bypass completo do segundo fator de autenticação.
 */
describe('MFAService.verifyBackupCode', () => {
  const mfa = new MFAService();

  it('rejeita um código com 16 caracteres que nunca foi emitido para o usuário', () => {
    const storedHashedCodes = [mfa.hashBackupCode('aaaaaaaaaaaaaaaa'), mfa.hashBackupCode('bbbbbbbbbbbbbbbb')];

    // 16 caracteres, formato válido, mas nunca emitido — antes da correção isso passava.
    const result = mfa.verifyBackupCode(storedHashedCodes, 'ffffffffffffffff');

    expect(result.valid).toBe(false);
  });

  it('aceita um código que realmente está na lista de códigos ainda não usados', () => {
    const realCode = 'a1b2c3d4e5f6a7b8';
    const storedHashedCodes = [mfa.hashBackupCode(realCode)];

    const result = mfa.verifyBackupCode(storedHashedCodes, realCode);

    expect(result.valid).toBe(true);
    expect(result.matchedHash).toBe(mfa.hashBackupCode(realCode));
  });

  it('rejeita reutilização: código removido da lista após o uso não é mais válido', () => {
    const realCode = 'a1b2c3d4e5f6a7b8';
    let storedHashedCodes = [mfa.hashBackupCode(realCode)];

    const first = mfa.verifyBackupCode(storedHashedCodes, realCode);
    expect(first.valid).toBe(true);

    // Simula o consumo do código (removido pelo chamador após uso bem-sucedido)
    storedHashedCodes = storedHashedCodes.filter((h) => h !== first.matchedHash);

    const second = mfa.verifyBackupCode(storedHashedCodes, realCode);
    expect(second.valid).toBe(false);
  });

  it('rejeita formato inválido antes mesmo de comparar', () => {
    const result = mfa.verifyBackupCode([], 'curto');
    expect(result.valid).toBe(false);
  });
});

/**
 * CORREÇÃO: o segredo TOTP era gerado em base64 mas embutido na URI
 * `otpauth://` como se fosse Base32 (formato que apps como Google
 * Authenticator exigem) — o QR gerado não era compatível com esses apps.
 * Agora o segredo é gerado e decodificado em Base32 de ponta a ponta.
 */
describe('MFAService TOTP (Base32)', () => {
  const mfa = new MFAService();

  it('gera um segredo apenas com o alfabeto Base32 (RFC 4648, sem padding)', () => {
    const { secret } = mfa.generateSecret('user-1', 'user@example.com');
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('embute o segredo Base32 (não base64) na URI otpauth:// do QR code', () => {
    const { secret, qrCode } = mfa.generateSecret('user-1', 'user@example.com');
    expect(qrCode).toContain(`secret=${secret}`);
    // Base64 pode conter '+', '/' ou '=', que nunca aparecem em Base32.
    expect(secret).not.toMatch(/[+/=]/);
  });

  it('verifyCode aceita o código TOTP atual gerado a partir do mesmo segredo (round-trip)', () => {
    const { secret } = mfa.generateSecret('user-1', 'user@example.com');
    // Acessa o gerador privado só para produzir um código válido de teste,
    // simulando o que um app autenticador real calcularia a partir do
    // mesmo segredo Base32.
    const currentCode = (mfa as any).generateTOTP(secret);

    const result = mfa.verifyCode(secret, currentCode);
    expect(result.valid).toBe(true);
  });

  it('verifyCode rejeita um código incorreto', () => {
    const { secret } = mfa.generateSecret('user-1', 'user@example.com');
    const currentCode = (mfa as any).generateTOTP(secret);
    const wrongCode = (parseInt(currentCode, 10) + 1).toString().padStart(6, '0').slice(-6);

    const result = mfa.verifyCode(secret, wrongCode === currentCode ? '000000' : wrongCode);
    expect(result.valid).toBe(false);
  });
});
