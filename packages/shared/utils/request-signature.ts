import crypto from 'crypto';

/**
 * Assinatura de requisição servidor → servidor (Commerce API e entrada do monitor independente). FONTE ÚNICA: a API (`services/commerce/signature.ts` reexporta daqui)
 * e o serviço de monitoramento (`apps/monitor`) usam este mesmo código.
 *
 * O remetente envia cabeçalhos:
 *   X-Cortex-Timestamp:  segundos Unix do momento do envio
 *   X-Cortex-Signature:  `v1=<hex>` = HMAC-SHA256(segredo, `${timestamp}\n${MÉTODO}\n${caminho+query}\n${sha256(corpo)}`)
 *   (a Commerce API ainda envia X-Cortex-Key com o identificador público da credencial)
 *
 * Isso dá: autenticação (só quem tem o segredo assina), integridade do corpo, método e caminho amarrados, e anti-repetição pela janela de tempo (`toleranceSec`).
 * Repetição de escrita dentro da janela é barrada por idempotência no destino. A comparação é em tempo constante.
 */
export const SIGNATURE_TOLERANCE_SEC = 300;

export function bodyDigest(rawBody: Buffer | string | undefined): string {
  return crypto.createHash('sha256').update(rawBody ?? '').digest('hex');
}

export function canonicalString(input: { timestampSec: number; method: string; path: string; bodySha256: string }): string {
  return `${input.timestampSec}\n${input.method.toUpperCase()}\n${input.path}\n${input.bodySha256}`;
}

/** Usado por quem envia e pelos testes: devolve o valor do cabeçalho `X-Cortex-Signature`. */
export function signRequest(secret: string, input: { timestampSec: number; method: string; path: string; rawBody?: Buffer | string }): string {
  const canonical = canonicalString({ timestampSec: input.timestampSec, method: input.method, path: input.path, bodySha256: bodyDigest(input.rawBody) });
  return `v1=${crypto.createHmac('sha256', secret).update(canonical).digest('hex')}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'MALFORMED' | 'EXPIRED' | 'MISMATCH' };

export function verifyRequestSignature(input: {
  secret: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  method: string;
  path: string;
  rawBody?: Buffer | string;
  toleranceSec?: number;
  nowMs?: number;
}): SignatureCheck {
  const { secret, signatureHeader, timestampHeader, method, path, rawBody, toleranceSec = SIGNATURE_TOLERANCE_SEC, nowMs = Date.now() } = input;
  const timestampSec = Number(timestampHeader);
  const match = /^v1=([0-9a-f]{64})$/i.exec(signatureHeader ?? '');
  if (!timestampHeader || !/^\d{9,12}$/.test(timestampHeader) || !Number.isSafeInteger(timestampSec) || !match) return { ok: false, reason: 'MALFORMED' };
  if (Math.abs(nowMs / 1000 - timestampSec) > toleranceSec) return { ok: false, reason: 'EXPIRED' };
  const expected = crypto.createHmac('sha256', secret).update(canonicalString({ timestampSec, method, path, bodySha256: bodyDigest(rawBody) })).digest();
  const given = Buffer.from(match[1], 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'MISMATCH' };
  return { ok: true };
}
