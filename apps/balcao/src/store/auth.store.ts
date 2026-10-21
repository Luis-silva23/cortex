import { create } from 'zustand';
import type { AuthUser } from '../api/types';

/**
 * Sessão do atendente — SÓ EM MEMÓRIA. Antes ficava em `sessionStorage`, que o navegador pode RESTAURAR ("reabrir abas",
 * recuperação depois de queda): num computador de balcão compartilhado, o próximo a abrir o navegador reentraria com a identidade
 * de quem saiu sem fechar a sessão (o refresh token vale dias). Agora fechar a aba/janela, reiniciar ou recarregar a página
 * exige login de novo. Sair da conta revoga a sessão no servidor (api/endpoints.ts → logout) e zera este store.
 *
 * O PDV Desktop usa o mesmo princípio (src/store/auth.store.ts do PDV) e é uma sessão SEPARADA: entrar ou sair de um não entra
 * nem sai do outro. O armazenamento de token no navegador segue sujeito à decisão 108 (script injetado lê a memória da página;
 * mitigado pela CSP do nginx do Balcão).
 *
 * `branchId` escolhido é o da operação: quem é da empresa toda (sem filial no token) escolhe UMA filial DA empresa; o servidor
 * valida (BRANCH_NOT_FOUND) e o usuário de filial é preso à própria filial pelo servidor.
 */
interface AuthState {
  user: AuthUser | null;
  token: string | null;
  refreshToken: string | null;
  /** Filial da operação (a do token ou, para a empresa toda, a escolhida). */
  branchId: string | null;
  isAuthenticated: boolean;
  login: (user: AuthUser, token: string, refreshToken: string) => void;
  setTokens: (token: string, refreshToken: string) => void;
  setBranch: (branchId: string | null) => void;
  logout: () => void;
}

// Limpeza de legado: a versão anterior gravava a sessão em sessionStorage (`balcao-auth`). Apagada na primeira abertura.
try {
  sessionStorage.removeItem('balcao-auth');
  localStorage.removeItem('balcao-auth');
} catch {
  /* armazenamento indisponível */
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  token: null,
  refreshToken: null,
  branchId: null,
  isAuthenticated: false,
  login: (user, token, refreshToken) => set({ user, token, refreshToken, branchId: user.branchId ?? null, isAuthenticated: true }),
  setTokens: (token, refreshToken) => set({ token, refreshToken }),
  setBranch: (branchId) => set({ branchId }),
  logout: () => set({ user: null, token: null, refreshToken: null, branchId: null, isAuthenticated: false }),
}));
