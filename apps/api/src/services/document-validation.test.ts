import { isValidCPF, isValidCNPJ, isValidDocument } from '@ln-system/shared/utils/validation';

/**
 * CPF/CNPJ nunca tinham validação real (só limite de tamanho da string) —
 * qualquer sequência de 11/14 dígitos passava, inclusive "00000000000".
 * Estes testes usam CPFs/CNPJs de teste publicamente conhecidos e válidos
 * (mesmo algoritmo de dígito verificador usado pela Receita Federal).
 */
describe('isValidCPF', () => {
  it('aceita um CPF válido (com e sem máscara)', () => {
    expect(isValidCPF('111.444.777-35')).toBe(true);
    expect(isValidCPF('11144477735')).toBe(true);
  });

  it('rejeita CPF com dígito verificador incorreto', () => {
    expect(isValidCPF('111.444.777-36')).toBe(false);
  });

  it('rejeita CPF com todos os dígitos iguais (formato válido, número falso)', () => {
    expect(isValidCPF('00000000000')).toBe(false);
    expect(isValidCPF('11111111111')).toBe(false);
  });

  it('rejeita CPF com tamanho errado', () => {
    expect(isValidCPF('123456789')).toBe(false);
    expect(isValidCPF('123456789012')).toBe(false);
  });
});

describe('isValidCNPJ', () => {
  it('aceita um CNPJ válido (com e sem máscara)', () => {
    expect(isValidCNPJ('11.222.333/0001-81')).toBe(true);
    expect(isValidCNPJ('11222333000181')).toBe(true);
  });

  it('rejeita CNPJ com dígito verificador incorreto', () => {
    expect(isValidCNPJ('11.222.333/0001-82')).toBe(false);
  });

  it('rejeita CNPJ com todos os dígitos iguais', () => {
    expect(isValidCNPJ('00000000000000')).toBe(false);
  });

  it('rejeita CNPJ com tamanho errado', () => {
    expect(isValidCNPJ('1122233300018')).toBe(false);
  });
});

describe('isValidDocument', () => {
  it('detecta e valida CPF (11 dígitos) e CNPJ (14 dígitos) automaticamente', () => {
    expect(isValidDocument('111.444.777-35')).toBe(true);
    expect(isValidDocument('11.222.333/0001-81')).toBe(true);
  });

  it('rejeita documento com quantidade de dígitos que não é nem CPF nem CNPJ', () => {
    expect(isValidDocument('123456')).toBe(false);
  });
});
