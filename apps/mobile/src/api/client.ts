import axios, { AxiosInstance } from 'axios';
import * as SecureStore from 'expo-secure-store';
import type {
  AppointmentsList,
  FollowUpDashboard,
  LoginResponse,
  ServiceOrderDetail,
  ServiceOrdersList,
  SessionUser,
} from './types';

// `EXPO_PUBLIC_*` é inlined em build time pelo Expo (SDK 49+) — o padrão
// aponta para o emulador Android (10.0.2.2 é o alias do host da máquina
// dentro do AVD; `localhost` de dentro do emulador é o próprio emulador,
// nunca a máquina que roda a API). Em um device físico isso PRECISA ser
// sobrescrito para o IP de LAN da máquina rodando `npm run dev` da API,
// via `.env`/`eas.json` — não existe forma de adivinhar isso em build time.
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:3001/api';

// Build de PRODUÇÃO só fala HTTPS (falha fechada: um build sem EXPO_PUBLIC_API_URL https não abre, em vez de trafegar senha em texto
// puro). Não existe opção de ignorar erro de certificado: vale a validação padrão do sistema. Em desenvolvimento (__DEV__) o padrão
// do emulador continua valendo.
if (!__DEV__ && !/^https:\/\/[^/@\s]+/i.test(API_URL)) {
  throw new Error('EXPO_PUBLIC_API_URL precisa ser uma URL https (sem usuário/senha) em build de produção');
}

const ACCESS_TOKEN_KEY = 'ln_access_token';
const REFRESH_TOKEN_KEY = 'ln_refresh_token';

// SecureStore (Keystore no Android) — nunca AsyncStorage puro para
// token/refreshToken, mesmo padrão de "nunca confiar em armazenamento não
// criptografado para credenciais" já seguido no resto do projeto (ver
// admin-web/lib/api.ts, que usa localStorage por ser web — aqui o
// equivalente seguro é o Keystore).
async function getAccessToken() {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}
async function getRefreshToken() {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}
/** Canal em que o cliente/responsável confirmou o agendamento (enum ContactChannel da API). */
export type ConfirmationChannel = 'PHONE' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'IN_PERSON';

export async function persistSession(accessToken: string, refreshToken: string) {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
}
export async function clearSession() {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

// Notifica o auth.store quando um 401 força logout (token expirado/
// revogado no meio de uma sessão) — client.ts não importa o store
// diretamente (evita ciclo de import); o store registra este callback.
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
    // timeout: sem ele uma requisição pendurada (rede ruim) nunca resolvia nem rejeitava — a tela ficava
    // em "carregando" e o "Sair" podia travar em `await apiClient.logout()`.
    this.client = axios.create({ baseURL: API_URL, timeout: 15000, headers: { 'Content-Type': 'application/json' } });

    this.client.interceptors.request.use(async (config) => {
      const token = await getAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    // Só tenta renovar automaticamente 1 vez por requisição (_retry) — sem
    // essa guarda, um refreshToken também inválido causaria um loop de 401
    // infinito em vez de deslogar de verdade.
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
          // 5xx ou 429 na hora de renovar é transitória: mantém os tokens e deixa a próxima tentativa
          // recuperar — antes qualquer falha deslogava o aparelho.
          if (outcome.sessionInvalid) {
            await clearSession();
            onSessionExpired?.();
          }
        }
        return Promise.reject(error);
      }
    );
  }

  // Coalesce: se várias respostas chegarem 401 ao mesmo tempo (várias
  // chamadas em paralelo numa tela), só dispara UM /auth/refresh — as
  // outras esperam a mesma promise em vez de cada uma tentar renovar.
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

  async logout(): Promise<void> {
    const refreshToken = await getRefreshToken();
    if (refreshToken) {
      await this.client.post('/auth/logout', { refreshToken }).catch(() => {
        // logout é best-effort no cliente — mesmo se a chamada falhar
        // (rede fora do ar), a sessão local já foi limpa por quem chamou.
      });
    }
  }

  async me(): Promise<SessionUser> {
    const { data } = await this.client.get('/auth/me');
    return data.data as SessionUser;
  }

  async getFollowUpDashboard(branchId?: string): Promise<FollowUpDashboard> {
    const { data } = await this.client.get<FollowUpDashboard>('/follow-ups/dashboard', { params: { branchId } });
    return data;
  }

  async getAppointments(params: { from?: string; to?: string; status?: string; page?: number; limit?: number } = {}): Promise<AppointmentsList> {
    const { data } = await this.client.get<AppointmentsList>('/appointments', { params });
    return data;
  }

  // Confirmação do CLIENTE/responsável pelo veículo: quem confirmou e o canal são obrigatórios na API.
  async confirmAppointment(id: string, confirmation: { channel: ConfirmationChannel; confirmedByName: string; notes?: string }): Promise<void> {
    await this.client.post(`/appointments/${id}/confirm`, confirmation);
  }

  // Reagendar reseta a confirmação (ver appointment.service.ts) — o
  // cliente precisa confirmar o novo horário de novo. Cancelar devolve o
  // follow-up ligado para "Próximas revisões".
  async rescheduleAppointment(id: string, newScheduledAt: string, reason?: string): Promise<void> {
    await this.client.post(`/appointments/${id}/reschedule`, { newScheduledAt, reason });
  }

  async cancelAppointment(id: string, reason?: string): Promise<void> {
    await this.client.post(`/appointments/${id}/cancel`, { reason });
  }

  // [agenda 2026-09-27] Concluir. Sem a confirmação do cliente a API responde 409 APPOINTMENT_NOT_CONFIRMED; aí a tela
  // pede a autorização de um responsável (código + senha dele, MFA se tiver) e o motivo (mín. 10).
  async completeAppointment(
    id: string,
    body: { notes?: string; authorization?: { authorizerNumericId: number; authorizerPassword: string; authorizerMfaCode?: string; reason: string } } = {}
  ): Promise<void> {
    await this.client.post(`/appointments/${id}/complete`, body);
  }

  async getServiceOrders(params: { status?: string; page?: number; limit?: number } = {}): Promise<ServiceOrdersList> {
    const { data } = await this.client.get<ServiceOrdersList>('/service-orders', { params });
    return data;
  }

  async getServiceOrder(id: string): Promise<ServiceOrderDetail> {
    const { data } = await this.client.get<ServiceOrderDetail>(`/service-orders/${id}`);
    return data;
  }
}

export const apiClient = new ApiClient();
