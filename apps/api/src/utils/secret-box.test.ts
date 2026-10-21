import { assertEncryptionKey, isSealed, openSecret, sealSecret } from '@ln-system/shared/utils/secret-box';

describe('secret-box (segredos cifrados em repouso)', () => {
  const TOTP = 'JBSWY3DPEHPK3PXP';

  it('cifra: o valor gravado não contém o segredo e volta idêntico', () => {
    const sealed = sealSecret(TOTP);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain(TOTP);
    expect(openSecret(sealed)).toBe(TOTP);
  });

  it('IV aleatório: o mesmo segredo gera valores diferentes', () => {
    expect(sealSecret(TOTP)).not.toBe(sealSecret(TOTP));
  });

  it('não cifra duas vezes', () => {
    const sealed = sealSecret(TOTP);
    expect(sealSecret(sealed)).toBe(sealed);
  });

  it('adulteração do valor gravado é detectada (GCM)', () => {
    const sealed = sealSecret(TOTP);
    const parts = sealed.split(':');
    const data = Buffer.from(parts[4], 'base64url');
    data[0] ^= 0xff;
    parts[4] = data.toString('base64url');
    expect(() => openSecret(parts.join(':'))).toThrow();
  });

  it('valor legado em texto puro é devolvido como está (migração sem derrubar login); nulo continua nulo', () => {
    expect(openSecret(TOTP)).toBe(TOTP);
    expect(openSecret(null)).toBeNull();
  });

  it('outra chave não abre', () => {
    const sealed = sealSecret(TOTP);
    const original = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = Buffer.from('another-test-key-with-32-bytes!!').toString('base64');
    try {
      expect(() => openSecret(sealed)).toThrow();
    } finally {
      process.env.DATA_ENCRYPTION_KEY = original;
    }
  });

  it('sem chave (ou chave curta): falha explícita, nunca grava em texto puro', () => {
    const original = process.env.DATA_ENCRYPTION_KEY;
    try {
      delete process.env.DATA_ENCRYPTION_KEY;
      expect(() => assertEncryptionKey()).toThrow(/DATA_ENCRYPTION_KEY/);
      expect(() => sealSecret(TOTP)).toThrow(/DATA_ENCRYPTION_KEY/);
      process.env.DATA_ENCRYPTION_KEY = Buffer.from('curta').toString('base64');
      expect(() => assertEncryptionKey()).toThrow(/DATA_ENCRYPTION_KEY/);
    } finally {
      process.env.DATA_ENCRYPTION_KEY = original;
    }
  });
});
