/**
 * REVOGAÇÃO DE SESSÃO DO OPERADOR (lógica pura, sem Electron/Vite — testável com `tsx --test`).
 *
 * O PDV NÃO restaura sessão: o par de tokens vive só na memória do renderer (auth.store.ts). Ao sair da conta, fechar a janela ou
 * encerrar o aplicativo, o refresh token é REVOGADO NO SERVIDOR (POST /api/auth/logout). Se o servidor não puder ser alcançado
 * nesse momento (queda de rede, timeout, 5xx), o aplicativo NÃO continua com a sessão: ele só guarda o refresh token numa fila
 * mínima — cifrada pelo sistema operacional (Electron `safeStorage`) — com UM único uso: tentar a revogação de novo na próxima
 * abertura do aplicativo e quando a rede voltar. Esse token nunca é usado para autenticar nem para reabrir a sessão.
 *
 *   revoked      → o servidor confirmou (2xx): nada a guardar.
 *   rejected     → o servidor respondeu 4xx: o token já era inválido/revogado/expirado: nada a guardar.
 *   unreachable  → sem resposta confiável (rede, timeout, 5xx): entra na fila para nova tentativa.
 */
export type RevokeResult = 'revoked' | 'rejected' | 'unreachable';

export interface RevocationStorage {
  read(): Promise<string | null>;
  write(value: string | null): Promise<void>;
}

export interface RevocationDeps {
  storage: RevocationStorage;
  revoke: (refreshToken: string, accessToken?: string | null) => Promise<RevokeResult>;
}

/** Limite da fila: o operador sai poucas vezes sem rede; acima disso os mais antigos já expiraram no servidor. */
export const MAX_PENDING = 10;

/** Classifica a resposta HTTP de /auth/logout (undefined = sem resposta). */
export function classifyLogoutStatus(status: number | undefined): RevokeResult {
  if (status === undefined) return 'unreachable';
  if (status >= 200 && status < 300) return 'revoked';
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'rejected';
  return 'unreachable'; // 408, 429, 5xx
}

async function readQueue(storage: RevocationStorage): Promise<string[]> {
  try {
    const raw = await storage.read();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string' && t.length > 0).slice(-MAX_PENDING) : [];
  } catch {
    return [];
  }
}

async function writeQueue(storage: RevocationStorage, queue: string[]): Promise<void> {
  await storage.write(queue.length === 0 ? null : JSON.stringify(queue.slice(-MAX_PENDING)));
}

/** Tenta revogar agora; se o servidor não confirmou nem recusou, guarda para tentar de novo. Nunca lança. */
export async function revokeOrQueue(deps: RevocationDeps, refreshToken: string | null, accessToken?: string | null): Promise<RevokeResult | 'nothing'> {
  if (!refreshToken) return 'nothing';
  let result: RevokeResult;
  try {
    result = await deps.revoke(refreshToken, accessToken);
  } catch {
    result = 'unreachable';
  }
  if (result === 'unreachable') {
    try {
      const queue = await readQueue(deps.storage);
      if (!queue.includes(refreshToken)) queue.push(refreshToken);
      await writeQueue(deps.storage, queue);
    } catch {
      /* sem armazenamento seguro: o token só existia na memória e foi descartado; o servidor o expira sozinho */
    }
  }
  return result;
}

/** Reenvia as revogações pendentes. Devolve quantas ficaram (sem rede) — as confirmadas/recusadas saem da fila. */
export async function flushPending(deps: RevocationDeps): Promise<{ remaining: number; cleared: number }> {
  const queue = await readQueue(deps.storage);
  if (queue.length === 0) return { remaining: 0, cleared: 0 };
  const keep: string[] = [];
  for (const token of queue) {
    let result: RevokeResult;
    try {
      result = await deps.revoke(token, null);
    } catch {
      result = 'unreachable';
    }
    if (result === 'unreachable') keep.push(token);
  }
  try {
    await writeQueue(deps.storage, keep);
  } catch {
    /* mantém o que estava */
  }
  return { remaining: keep.length, cleared: queue.length - keep.length };
}
