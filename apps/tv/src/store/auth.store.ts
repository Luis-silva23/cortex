import { create } from 'zustand';
import { apiClient, clearSession, persistSession, setSessionExpiredHandler } from '../api/client';
import * as SecureStore from 'expo-secure-store';
import { isMfaRequired, SessionUser } from '../api/types';

const USER_CACHE_KEY = 'ln_tv_user_cache';

type AuthStatus = 'loading' | 'signedOut' | 'mfaPending' | 'signedIn';

interface AuthState {
  status: AuthStatus;
  user: SessionUser | null;
  mfaToken: string | null;
  error: string | null;
  loadSession: () => Promise<void>;
  login: (credentials: { email?: string; numericId?: number; password: string }) => Promise<void>;
  verifyMfa: (code: string) => Promise<void>;
  logout: () => Promise<void>;
}

// Mesmo padrão de apps/mobile/src/store/auth.store.ts: GET /auth/me é a
// única fonte de verdade sobre a sessão. No painel isso importa ainda mais
// — o dispositivo fica ligado o dia inteiro sem interação humana, então
// não há "usuário clicando em login de novo" para se recuperar de um
// token indevidamente aceito como válido.
export const useAuthStore = create<AuthState>((set, get) => {
  setSessionExpiredHandler(() => {
    set({ status: 'signedOut', user: null, mfaToken: null });
  });

  return {
    status: 'loading',
    user: null,
    mfaToken: null,
    error: null,

    async loadSession() {
      try {
        const cached = await SecureStore.getItemAsync(USER_CACHE_KEY);
        if (cached) {
          set({ user: JSON.parse(cached) });
        }
        const user = await apiClient.me();
        await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(user));
        set({ status: 'signedIn', user, error: null });
      } catch (error: any) {
        const status = error?.response?.status;
        if (status === 401 || status === 403) {
          // o servidor disse que a sessão não vale (o interceptor já tentou renovar): sai de verdade
          await clearSession();
          set({ status: 'signedOut', user: null });
          return;
        }
        // Sem rede, timeout, 5xx ou 429: NÃO é motivo para apagar a sessão. Um painel de parede que reinicia
        // com a API/rede fora perdia o login e exigia senha (e TOTP) digitados com o controle remoto. Mantém
        // os tokens; com o usuário em cache entra e o polling se recupera sozinho quando a rede voltar.
        const cachedUser = get().user;
        set(cachedUser ? { status: 'signedIn', error: null } : { status: 'signedOut' });
      }
    },

    async login(credentials) {
      set({ error: null });
      try {
        const result = await apiClient.login(credentials);
        if (isMfaRequired(result)) {
          set({ status: 'mfaPending', mfaToken: result.mfaToken });
          return;
        }
        await persistSession(result.accessToken, result.refreshToken);
        await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(result.user));
        set({ status: 'signedIn', user: result.user, mfaToken: null });
      } catch (err: any) {
        set({ error: err?.response?.data?.message || 'Não foi possível entrar. Tente novamente.' });
        throw err;
      }
    },

    async verifyMfa(code) {
      const { mfaToken } = get();
      if (!mfaToken) {
        throw new Error('Sessão de MFA expirada — faça login novamente.');
      }
      set({ error: null });
      try {
        const result = await apiClient.verifyMfa(mfaToken, code);
        if (isMfaRequired(result)) {
          throw new Error('Resposta inesperada do servidor ao verificar o código.');
        }
        await persistSession(result.accessToken, result.refreshToken);
        await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(result.user));
        set({ status: 'signedIn', user: result.user, mfaToken: null });
      } catch (err: any) {
        set({ error: err?.response?.data?.message || 'Código inválido. Tente novamente.' });
        throw err;
      }
    },

    async logout() {
      await apiClient.logout();
      await clearSession();
      await SecureStore.deleteItemAsync(USER_CACHE_KEY);
      set({ status: 'signedOut', user: null, mfaToken: null });
    },
  };
});
