import axios, { AxiosError } from 'axios';
import { API_URL, APP_VERSION } from '../config';
import { useAuthStore } from '../store/auth.store';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '../lib/errors';

/**
 * Cliente HTTP ÚNICO do Balcão: tudo passa pelas rotas oficiais da API (`/api/*`); não há banco, regra nem cálculo próprios.
 * Autenticação por `Authorization: Bearer` (sem cookie, sem CSRF). Renovação do token em fila única (single-flight): várias
 * requisições em 401 ao mesmo tempo renovam UMA vez (a API rotaciona o refresh e trata reapresentação como roubo).
 */
export class ApiError extends Error {
  constructor(message: string, public status?: number, public code?: string, public data?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

export const http = axios.create({
  baseURL: `${API_URL}/api`,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json', 'X-Client-Source': 'BALCAO', 'X-App-Version': APP_VERSION },
});

// Chamadas de autenticação nunca entram no "renova e repete" (401 do login é senha errada, não sessão expirada).
const AUTH_PATHS = ['/auth/login', '/auth/verify-mfa', '/auth/refresh', '/auth/logout'];

http.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let refreshInFlight: Promise<string> | null = null;
function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { refreshToken } = useAuthStore.getState();
      if (!refreshToken) throw new Error('Sessão expirada');
      const res = await axios.post(`${API_URL}/api/auth/refresh`, { refreshToken }, { timeout: 20000 });
      const accessToken: string = res.data.accessToken ?? res.data.data?.accessToken;
      const rotated: string = res.data.refreshToken ?? res.data.data?.refreshToken ?? refreshToken;
      useAuthStore.getState().setTokens(accessToken, rotated); // o refresh antigo já foi revogado pela API
      return accessToken;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<any>) => {
    const original: any = error.config;
    const isAuthCall = AUTH_PATHS.some((p) => String(original?.url || '').includes(p));
    if (error.response?.status === 401 && original && !original._retry && !isAuthCall) {
      original._retry = true;
      try {
        const accessToken = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${accessToken}`;
        return http(original);
      } catch {
        useAuthStore.getState().logout(); // sessão irrecuperável (inclui equipamento/sessão encerrados): volta ao login
      }
    }
    return Promise.reject(toApiError(error));
  }
);

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const ax = error as AxiosError<any>;
  if (!ax?.response) return new ApiError(NETWORK_ERROR_MESSAGE);
  const { status, data } = ax.response;
  return new ApiError(apiErrorMessage(data, status), status, typeof data?.code === 'string' ? data.code : undefined, data);
}
