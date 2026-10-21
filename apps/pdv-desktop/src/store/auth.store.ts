import { create } from 'zustand';
import { useCartStore } from './cart.store';
import { useCashRegisterStore } from './cashRegister.store';
import { useCheckoutStore } from './checkout.store';

// Carrinho e caixa aberto são estado do OPERADOR. Eles vivem em stores separados, em memória, e o
// logout só limpava a sessão: o operador seguinte (login sem recarregar a janela) via o carrinho do
// anterior e o POS reaproveitava o `currentCashRegister` dele — vendendo NO CAIXA DE OUTRA PESSOA.
// Zerado no logout (inclusive o forçado por sessão expirada) e no login.
function resetOperatorState() {
  useCartStore.getState().clearCart();
  useCashRegisterStore.getState().setCurrentCashRegister(null);
  // venda/pagamento em andamento também é do operador (nunca herdado por quem entra depois)
  useCheckoutStore.getState().reset();
}

// A SESSÃO NÃO É PERSISTIDA. Este store vivia num `persist` (safeStorage cifrado), o que RESTAURAVA o operador anterior ao
// reabrir o aplicativo — num computador de loja usado por várias pessoas, quem abrisse o PDV depois herdava a identidade e o
// caixa de quem tinha saído. Agora o par de tokens existe só na memória do renderer: fechar o aplicativo, reiniciar o
// computador ou recarregar a janela exige login de novo, com o identificador e a senha de quem vai operar. O encerramento no
// servidor (revogação do refresh token) está em services/session.ts. Nenhuma credencial de operador é gravada em disco.
//
// Limpeza de legado: instalações anteriores deixaram a sessão do último operador em `secure-pdv-auth-storage.dat` (e, fora do
// Electron, em localStorage). É apagada na primeira abertura desta versão para que nunca seja lida por nada.
const LEGACY_KEY = 'pdv-auth-storage';
function purgeLegacyPersistedSession() {
  try {
    void window.electron?.secureStorage?.removeItem(LEGACY_KEY);
  } catch {
    /* sem ponte do Electron (navegador de desenvolvimento) */
  }
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* localStorage indisponível */
  }
}
purgeLegacyPersistedSession();

interface User {
  id: string;
  numericId: number;
  name: string;
  email: string;
  userType: string;
  companyId: string;
  branchId?: string;
  company?: { id: string; name: string; document: string; phone?: string };
  branch?: { id: string; name: string; address?: string; phone?: string };
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  /**
   * Tela BLOQUEADA: a sessão continua (a venda em andamento não se perde), mas nenhuma tela do PDV fica disponível até o
   * operador confirmar a PRÓPRIA senha no servidor (services/session.ts → verifyOwnPassword). Não é logout nem fechamento de
   * caixa. Não é persistido: reiniciar o aplicativo já exige login completo.
   */
  locked: boolean;
  // Sem persistência não há reidratação: fica sempre `true`. O campo é mantido porque o roteador (App.tsx) e testes antigos
  // o leem; deixá-lo evita mexer em quem depende dele.
  hasHydrated: boolean;
  login: (user: User, token: string, refreshToken: string) => void;
  logout: () => void;
  lock: () => void;
  unlock: () => void;
  updateToken: (token: string) => void;
  // A API ROTACIONA o refresh token a cada /auth/refresh (o antigo é revogado). Guardar só o novo
  // access token deixava o refresh já revogado no store: no 2º vencimento (~30 min) ele era
  // reapresentado, a API detectava "reuso" e revogava TODAS as sessões do operador.
  setTokens: (token: string, refreshToken: string) => void;
  setHasHydrated: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  token: null,
  refreshToken: null,
  isAuthenticated: false,
  locked: false,
  hasHydrated: true,
  login: (user, token, refreshToken) => {
    resetOperatorState();
    set({
      user,
      token,
      refreshToken,
      isAuthenticated: true,
      locked: false,
    });
  },
  logout: () => {
    resetOperatorState();
    set({
      user: null,
      token: null,
      refreshToken: null,
      isAuthenticated: false,
      locked: false,
    });
  },
  lock: () => set((state) => (state.isAuthenticated ? { locked: true } : state)),
  unlock: () => set({ locked: false }),
  updateToken: (token) => set({ token }),
  setTokens: (token, refreshToken) => set({ token, refreshToken }),
  setHasHydrated: (value) => set({ hasHydrated: value }),
}));
