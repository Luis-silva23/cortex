import { createHash } from 'crypto';

/**
 * HASH DO REFRESH TOKEN — o banco guarda só o SHA-256 (hex, 64 caracteres) do token, nunca o token.
 * O refresh token é um JWT longo e aleatório (assinado, com `jti`/id da linha): não precisa de sal nem de hash lento — o que se protege é que
 * quem lê o banco ou um backup NÃO obtém uma credencial utilizável (o hash não serve para renovar a sessão). A busca é por igualdade do hash.
 * A migration `20261014170000_refresh_tokens_hash_and_company` calcula o MESMO hash em SQL (`encode(sha256(convert_to(token, 'UTF8')), 'hex')`)
 * para as sessões já abertas, então nenhuma sessão legítima cai na troca.
 * Nada aqui escreve token ou hash em log.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
