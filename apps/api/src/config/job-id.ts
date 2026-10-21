/**
 * `jobId` determinístico das filas BullMQ (idempotência: o mesmo evento não vira dois jobs).
 *
 * O BullMQ 5 RECUSA `jobId` com ":" ("Custom Id cannot contain :") e `jobId` que seja só um inteiro. Os ids antigos eram
 * `license-expiring:<empresa>:<e-mail>:<dias>` etc.: a chamada lançava e a notificação (estoque baixo, licença a vencer, fatura,
 * venda, backup) nunca era enfileirada — o teste unitário não via isso porque a fila era simulada. Agora as partes são juntadas
 * com "|" e qualquer ":" dentro de uma parte (ex.: caminho `C:\backups\x.dump`) vira "_".
 */
export function jobKey(...parts: Array<string | number>): string {
  return parts.map((p) => String(p).replace(/:/g, '_')).join('|');
}
