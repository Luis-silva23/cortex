/**
 * CICLO DE VIDA DA SESSÃO DO OPERADOR NO PDV DESKTOP (ver session-revocation.ts para a regra e os estados).
 *
 *  - Sair da conta e fechar o aplicativo SEMPRE descartam a sessão local (memória) e pedem a revogação ao servidor.
 *  - Nada é restaurado na próxima abertura: cada operador entra com o próprio identificador e senha.
 *  - Revogação que não chegou ao servidor (sem rede) fica numa fila cifrada pelo SO, usada só para tentar de novo.
 *  - "Bloquear" (auth.store: lock/unlock) é outra operação: a sessão continua, a tela fica indisponível até a senha ser conferida.
 *  - "Fechar o caixa" é operação financeira (CashRegisterPage) e NUNCA acontece por sair da conta ou fechar o aplicativo.
 */
import axios from 'axios';
import { API_URL, SERVER_URL_PROBLEM } from './server-config';
import { useAuthStore } from '../store/auth.store';
import {
  classifyLogoutStatus,
  flushPending,
  revokeOrQueue,
  type RevocationDeps,
  type RevocationStorage,
  type RevokeResult,
} from './session-revocation';

const QUEUE_KEY = 'pdv-pending-revocation';
const REVOKE_TIMEOUT_MS = 5000;
/** Tempo máximo esperando o servidor ao FECHAR o aplicativo (o processo principal força o fechamento um pouco depois). */
const CLOSE_WAIT_MS = 3500;

// Fila só em armazenamento cifrado do SO (Electron safeStorage). No navegador comum (desenvolvimento) não há onde guardar com
// segurança: nada é gravado e a revogação pendente é abandonada (o servidor expira o token sozinho).
const storage: RevocationStorage = {
  async read() {
    const secure = window.electron?.secureStorage;
    if (!secure) return null;
    const result = await secure.getItem(QUEUE_KEY);
    return result.success ? result.value ?? null : null;
  },
  async write(value) {
    const secure = window.electron?.secureStorage;
    if (!secure) return;
    if (value === null) await secure.removeItem(QUEUE_KEY);
    else await secure.setItem(QUEUE_KEY, value);
  },
};

async function revoke(refreshToken: string, accessToken?: string | null): Promise<RevokeResult> {
  if (SERVER_URL_PROBLEM) return 'unreachable';
  try {
    const response = await axios.post(
      `${API_URL}/api/auth/logout`,
      { refreshToken },
      {
        timeout: REVOKE_TIMEOUT_MS,
        // o access token (quando ainda existe) também deixa de valer no servidor; a fila só tem o refresh token
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
        validateStatus: () => true,
      }
    );
    return classifyLogoutStatus(response.status);
  } catch {
    return 'unreachable';
  }
}

const deps: RevocationDeps = { storage, revoke };

/**
 * Sai da conta: a sessão local é descartada PRIMEIRO (a tela cai no login na hora e nenhum outro operador herda a identidade),
 * depois pede a revogação ao servidor. Sem resposta do servidor, a revogação fica pendente (ver fila). Nunca lança.
 */
export async function signOut(): Promise<RevokeResult | 'nothing'> {
  const { token, refreshToken } = useAuthStore.getState();
  useAuthStore.getState().logout();
  return revokeOrQueue(deps, refreshToken, token);
}

/** Reenvia as revogações que ficaram pendentes. Seguro de chamar à vontade (fila vazia = nada acontece). */
export async function flushPendingRevocations(): Promise<{ remaining: number; cleared: number }> {
  try {
    return await flushPending(deps);
  } catch {
    return { remaining: 0, cleared: 0 };
  }
}

/**
 * Faxina da sessão enquanto o aplicativo está aberto: tenta as revogações pendentes agora e sempre que a rede volta, e responde
 * ao pedido do processo principal para encerrar a sessão ANTES de fechar a janela (botão fechar, Alt+F4, encerramento do SO).
 * Encerramento forçado (gerenciador de tarefas, queda de energia) não executa nada aqui — e nem precisa: nada é restaurado
 * na próxima abertura e o token do processo morto só existia na memória dele.
 */
export function startSessionHousekeeping(): () => void {
  void flushPendingRevocations();
  const onOnline = () => void flushPendingRevocations();
  window.addEventListener('online', onOnline);

  const stopClose = window.electron?.onBeforeClose?.(async () => {
    try {
      await Promise.race([signOut(), new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS))]);
    } finally {
      window.electron?.confirmClose?.();
    }
  });

  return () => {
    window.removeEventListener('online', onOnline);
    stopClose?.();
  };
}

/** Confere a senha do operador logado (tela bloqueada). A sessão NÃO é recriada; só o servidor decide se a senha está certa. */
export async function verifyOwnPassword(password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const { token } = useAuthStore.getState();
  if (!token) return { ok: false, message: 'Sessão encerrada. Entre novamente.' };
  try {
    const response = await axios.post(
      `${API_URL}/api/auth/reauthenticate`,
      { password },
      { timeout: 15000, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
    );
    if (response.status === 200) return { ok: true };
    if (response.status === 401 && response.data?.code === 'WRONG_PASSWORD') return { ok: false, message: 'Senha incorreta.' };
    if (response.status === 401 || response.status === 403) {
      // sessão revogada/expirada no servidor: não há o que desbloquear
      useAuthStore.getState().logout();
      return { ok: false, message: 'A sessão expirou. Entre novamente.' };
    }
    if (response.status === 429) return { ok: false, message: String(response.data?.message ?? 'Muitas tentativas. Aguarde um pouco.') };
    return { ok: false, message: 'Não foi possível conferir a senha agora. Tente de novo.' };
  } catch {
    return { ok: false, message: 'Sem conexão com o servidor: a tela continua bloqueada.' };
  }
}
