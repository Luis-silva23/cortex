import { containsCardNumber } from './support-sensitive';

describe('support-sensitive — número de cartão em chamado', () => {
  it('detecta cartão válido (Luhn), com ou sem separadores', () => {
    expect(containsCardNumber('cartão 4111111111111111 recusado')).toBe(true);
    expect(containsCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(containsCardNumber('5500-0000-0000-0004')).toBe(true);
    expect(containsCardNumber('378282246310005')).toBe(true);
  });
  it('não bloqueia números comuns do dia a dia', () => {
    expect(containsCardNumber('venda 1234 e OS 5678')).toBe(false);
    expect(containsCardNumber('CNPJ 12345678000195')).toBe(false); // 14 dígitos, não passa Luhn
    expect(containsCardNumber('telefone (11) 91234-5678')).toBe(false);
    expect(containsCardNumber('NSU 123456789012')).toBe(false); // 12 dígitos
    expect(containsCardNumber('final do cartão 1111')).toBe(false); // só os 4 últimos é permitido
    expect(containsCardNumber('')).toBe(false);
  });
  it('detecta cartão com agrupamento diferente de 4-4-4-4 e colado a outro número separado por espaço', () => {
    expect(containsCardNumber('Amex 3782 822463 10005')).toBe(true);
    expect(containsCardNumber('OS 123456 4111111111111111')).toBe(true);
    expect(containsCardNumber('cartão: 5500-0000-0000-0004.')).toBe(true);
  });

  it('NÃO confunde carimbo de tempo, chave de NF-e, boleto ou telefone com cartão (falso positivo que derrubava testes ao acaso)', () => {
    // 13 dígitos começando por 1 (Date.now()): o Luhn aprova ~10% deles ao acaso — nunca pode ser cartão
    let flagged = 0;
    for (let n = 1700000000000; n < 1700000000000 + 2000; n++) if (containsCardNumber(`rascunho-sup-${n}`)) flagged++;
    expect(flagged).toBe(0);
    // chave de NF-e (44 dígitos colados): janelas de 19 dígitos podem passar no Luhn — bloco colado > 19 não é cartão
    const key44 = (() => {
      for (let n = 0; n < 1000; n++) {
        const body = `35261014${String(n).padStart(11, '0')}`; // 19 primeiros dígitos
        if (containsCardNumber(body)) return body + '1'.repeat(25);
      }
      throw new Error('não achou janela de 19 dígitos que passe no Luhn (improvável)');
    })();
    expect(key44).toHaveLength(44);
    expect(containsCardNumber(`chave ${key44} da nota`)).toBe(false);
    expect(containsCardNumber('boleto 34191790010104351004791020150008291070026000')).toBe(false);
    expect(containsCardNumber('whatsapp +55 11 91234-5678')).toBe(false);
  });

  it('exige primeiro dígito de emissor (2 a 6): 13+ dígitos válidos no Luhn começando por 0, 1, 7, 8 ou 9 não são cartão', () => {
    expect(containsCardNumber('0000000000000')).toBe(false); // Luhn ok, mas não é número de emissor
    expect(containsCardNumber('1000000000008')).toBe(false);
    expect(containsCardNumber('7000000000000')).toBe(false);
  });

  it('sequência de 16 dígitos inválida pelo Luhn passa', () => {
    expect(containsCardNumber('4111111111111112')).toBe(false);
  });
});
