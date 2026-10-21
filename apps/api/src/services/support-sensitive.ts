/**
 * Chamado de suporte não é cofre: número de cartão completo não entra em assunto, descrição nem mensagem (docs/CORTEX/SUPPORT.md).
 * Detecta número de cartão: 13 a 19 dígitos (em um bloco ou em grupos separados por espaço/hífen), começando por 2 a 6 (todos os emissores:
 * Visa 4, Mastercard 5/2, Amex e JCB 3, Discover/Elo/Hipercard 6) e válidos no algoritmo de Luhn. Pedido recusado com mensagem clara — o
 * texto nunca é gravado nem registrado em log.
 *
 * Falso positivo corrigido (2026-10-15, causa da falha intermitente de `support.integration`, 14 testes): o Luhn aprova ~10% de qualquer
 * sequência numérica, então um carimbo de 13 dígitos (`Date.now()`), uma chave de NF-e (44 dígitos: duas janelas de 19 dígitos testadas),
 * um código de boleto ou um telefone com DDI eram recusados como "cartão" ao acaso. Agora: um bloco de dígitos COLADOS com mais de 19 dígitos
 * não é cartão (chave de NF-e, boleto, protocolo), e o primeiro dígito precisa ser de um emissor (carimbo de tempo começa por 1).
 */
export const SENSITIVE_DATA_MESSAGE = 'Não informe número de cartão, senha ou token no chamado. Remova o dado sensível e envie de novo.';

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function containsCardNumber(text: string): boolean {
  // cadeias de dígitos separadas por UM espaço ou hífen ("4111 1111 1111 1111"); cada grupo conta como um pedaço
  const chains = text.match(/\d+(?:[ -]\d+)*/g) ?? [];
  for (const chain of chains) {
    const tokens = chain.split(/[ -]/);
    for (let i = 0; i < tokens.length; i++) {
      let digits = '';
      for (let j = i; j < tokens.length; j++) {
        digits += tokens[j];
        if (digits.length > 19) break; // bloco colado maior que qualquer cartão: não é cartão (chave de NF-e, boleto…)
        if (digits.length >= 13 && /^[2-6]/.test(digits) && luhn(digits)) return true;
      }
    }
  }
  return false;
}
