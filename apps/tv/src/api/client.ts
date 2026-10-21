import axios, { AxiosInstance } from 'axios';
import * as SecureStore from 'expo-secure-store';
import type { AppointmentsList, LoginResponse, ServiceOrdersList, SessionUser } from './types';

// Mesma ressalva de apps/mobile/src/api/client.ts: 10.0.2.2 é o alias do
// host dentro do emulador Android — um device físico (Android TV de
// verdade) precisa do IP de LAN real da máquina rodando a API, configurado
// via EXPO_PUBLIC_API_URL em build/deploy.
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:3001/api';

// Build de PRODUÇÃO só fala HTTPS (falha fechada; ver apps/mobile/src/api/client.ts). Sem opção de ignorar erro de certificado.
if (!__DEV__ && !/^https:\/\/[^/@\s]+/i.test(API_URL)) {
  throw new Error('EXPO_PUBLIC_API_URL precisa ser uma URL https (sem usuário/senha) em build de produção');
}

const ACCESS_TOKEN_KEY = 'ln_tv_access_token';
const REFRESH_TOKEN_KEY = 'ln_tv_refresh_token';

async function getAccessToken() {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}
async function getRefreshToken() {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}
export async function persistSession(accessToken: string, refreshToken: string) {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
}
export async function clearSession() {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

// Resultado de uma tentativa de renovar a sessão: o token novo, ou o motivo de não ter (sessão recusada pelo
// servidor × falha transitória de rede/5xx/429 — só a primeira derruba o login).
type RefreshOutcome = { token: string | null; sessionInvalid: boolean };

class ApiClient {
  private client: AxiosInstance;
  private refreshingPromise: Promise<RefreshOutcome> | null = null;

  constructor() {
    // timeout: sem ele uma requisição pendurada (rede ruim) nunca resolvia nem rejeitava e o polling do painel
    // (a cada 30 s) empilhava chamadas.
    this.client = axios.create({ baseURL: API_URL, timeout: 15000, headers: { 'Content-Type': 'application/json' } });

    this.client.interceptors.request.use(async (config) => {
      const token = await getAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const original = error.config;
        // /auth/*: o 401 de login/código MFA é credencial errada, não sessão expirada — não passa pelo
        // renovar-e-repetir (antes limpava a sessão e disparava "sessão expirada" no meio do login).
        const isAuthCall = /\/auth\/(login|verify-mfa|refresh|logout)/.test(String(original?.url || ''));
        if (error.response?.status === 401 && original && !original._retry && !isAuthCall) {
          original._retry = true;
          const outcome = await this.tryRefresh();
          if (outcome.token) {
            original.headers.Authorization = `Bearer ${outcome.token}`;
            return this.client(original);
          }
          // Só derruba a sessão quando o SERVIDOR diz que ela não vale (refresh recusado). Falha de rede,
          // 5xx ou 429 na hora de renovar é transitória: mantém os tokens. Um painel de parede que reinicia
          // sem rede NÃO pode perder a sessão — reconfigurar exige senha (e TOTP) digitados no controle remoto.
          if (outcome.sessionInvalid) {
            await clearSession();
            onSessionExpired?.();
          }
        }
        return Promise.reject(error);
      }
    );
  }

  // O painel fica ligado o dia inteiro fazendo polling — sem o coalescing
  // aqui, um 401 simultâneo em duas chamadas do mesmo ciclo de refresh (ex.:
  // agenda + OS buscadas juntas) disparariam dois /auth/refresh ao mesmo
  // tempo, e o segundo chegaria com um refreshToken já rotacionado pelo
  // primeiro — falharia por engano.
  private async tryRefresh(): Promise<RefreshOutcome> {
    if (!this.refreshingPromise) {
      this.refreshingPromise = (async (): Promise<RefreshOutcome> => {
        const refreshToken = await getRefreshToken();
        if (!refreshToken) return { token: null, sessionInvalid: true };
        try {
          const { data } = await axios.post(`${API_URL}/auth/refresh`, { refreshToken }, { timeout: 15000 });
          await persistSession(data.accessToken, data.refreshToken);
          return { token: data.accessToken as string, sessionInvalid: false };
        } catch (error: any) {
          // 400/401/403 = o servidor recusou o refresh token (inválido/expirado/revogado): sessão perdida.
          // Sem resposta (rede/timeout), 5xx ou 429: falha transitória, a sessão continua válida.
          const status = error?.response?.status;
          return { token: null, sessionInvalid: status === 400 || status === 401 || status === 403 };
        }
      })().finally(() => {
        this.refreshingPromise = null;
      });
    }
    return this.refreshingPromise;
  }

  async login(credentials: { email?: string; numericId?: number; password: string }): Promise<LoginResponse> {
    const { data } = await this.client.post<LoginResponse>('/auth/login', credentials);
    return data;
  }

  async verifyMfa(mfaToken: string, code: string): Promise<LoginResponse> {
    const { data } = await this.client.post<LoginResponse>('/auth/verify-mfa', { mfaToken, code, method: 'totp' });
    return data;
  }

  async me(): Promise<SessionUser> {
    const { data } = await this.client.get('/auth/me');
    return data.data as SessionUser;
  }

  async logout(): Promise<void> {
    const refreshToken = await getRefreshToken();
    if (refreshToken) {
      await this.client.post('/auth/logout', { refreshToken }).catch(() => {});
    }
  }

  async getAppointmentsToday(branchId?: string): Promise<AppointmentsList> {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const { data } = await this.client.get<AppointmentsList>('/appointments', {
      params: { from: start, to: end, branchId, limit: 50 },
    });
    return data;
  }

  // "Em andamento" exclui PRONTO de propósito — um veículo pronto para
  // retirada é um estado mais urgente para quem olha o painel (avisar o
  // cliente) do que "ainda sendo trabalhado", por isso ganha sua própria
  // seção (getReadyServiceOrders) em vez de ficar misturado aqui.
  async getActiveServiceOrders(branchId?: string): Promise<ServiceOrdersList> {
    // Sem endpoint de "OS em andamento" pronto — filtramos no cliente pelos
    // status que o backend usa para OS ainda aberta (ver
    // service-order.service.ts::transitionStatus, ENCERRADA/CANCELADA são
    // terminais). Traz um limite generoso e filtra em memória: o volume de
    // OS ativas de uma oficina real nunca chega perto de precisar paginação
    // para isso.
    const { data } = await this.client.get<ServiceOrdersList>('/service-orders', {
      params: { branchId, limit: 100 },
    });
    return { ...data, orders: data.orders.filter((o) => !['ENCERRADA', 'CANCELADA', 'PRONTO'].includes(o.status)) };
  }

  // status=PRONTO filtrado no SERVIDOR (não em memória) — é um filtro
  // exato de igualdade, o backend já suporta via query string (ver
  // service-order.service.ts::list), então não há razão para trazer tudo
  // e filtrar no cliente como getActiveServiceOrders faz (lá o filtro é
  // "não está NESTE conjunto de status", que a rota não expõe direto).
  async getReadyServiceOrders(branchId?: string): Promise<ServiceOrdersList> {
    const { data } = await this.client.get<ServiceOrdersList>('/service-orders', {
      params: { branchId, status: 'PRONTO', limit: 50 },
    });
    return data;
  }
}

export const apiClient = new ApiClient();
