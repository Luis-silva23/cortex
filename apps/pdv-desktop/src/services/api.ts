import axios, { AxiosInstance, AxiosError } from 'axios';
import { useAuthStore } from '../store/auth.store';
import toast from 'react-hot-toast';
import { offlineService } from './offline.service';
import { requestDiscountAuthorization } from '../store/discountAuthorization.store';
import { API_URL } from './server-config';
import { getDeviceIdentity } from './device-enrollment';

/**
 * offline.service.ts (fila de sincronização via IndexedDB/Dexie) existia
 * desde antes, mas não era importado em NENHUM lugar do app — infra pronta
 * e nunca usada. Fila de venda/pagamento fica FORA de escopo aqui de
 * propósito: enfileirar uma venda offline exigiria lidar com validação de
 * estoque sem dado em tempo real, caixa aberto sem confirmação do backend,
 * numeração sequencial (saleNumber é atribuído pelo servidor) e o risco
 * real de duplicar/vender contra estoque inexistente ao sincronizar depois
 * — decisão de negócio/arquitetura que pertence à fase dedicada "Modo
 * Offline/Degradado" do roadmap, não a um bolt-on apressado aqui. O que É
 * seguro e de valor real imediato: cache local (read-only, idempotente) de
 * busca de produto/cliente, para o operador continuar CONSULTANDO catálogo
 * mesmo sem rede — nunca criar/alterar dado enquanto offline.
 */

// Endereço oficial do servidor, FIXADO na instalação (server-config.ts); em produção só HTTPS (o DeviceGate recusa o resto).
// Não há opção de "ignorar erro de certificado": a validação padrão do sistema vale.

// As rotas devolvem erro em formatos diferentes: `{ error: 'texto' }` (handlers), `{ message, code }`
// (errorHandler) e `{ error: 'Unauthorized', message: 'Credenciais inválidas' }` (auth). O texto útil
// nem sempre está em `error` — no login errado o operador via só "Unauthorized".
const GENERIC_HTTP_ERROR = /^(Unauthorized|Forbidden|Bad Request|Not Found|Conflict|Too Many Requests|Internal Server Error)$/i;
// `error` que é um CÓDIGO de máquina (MFA_ENROLLMENT_REQUIRED, DEVICE_PENDING…) não é texto para o operador: vale o `message`.
const MACHINE_CODE = /^[A-Z][A-Z0-9_]{2,}$/;
// Várias rotas fazem `res.status(400).json({ error: error.message })` e, para ZodError, `message` é o
// JSON cru da lista de problemas ("[ { "code": "invalid_type", ... } ]") — foi isso que o operador viu
// na tela ao finalizar uma venda. Converte para "campo: mensagem".
function readableValidationMessage(text: string): string {
  if (!text.trimStart().startsWith('[')) return text;
  try {
    const issues = JSON.parse(text);
    if (Array.isArray(issues) && issues.length && issues.every((i) => i && typeof i.message === 'string')) {
      return issues
        .map((i) => {
          const field = Array.isArray(i.path) && i.path.length ? i.path.join('.') : '';
          return field ? `${field}: ${i.message}` : i.message;
        })
        .join('; ');
    }
  } catch {
    // não era JSON de validação: devolve como veio
  }
  return text;
}

// 403 genérico (autenticado, sem permissão): uma frase padrão, sem revelar o recurso. 403 de negócio com texto próprio fica.
const NO_PERMISSION_MESSAGE = 'Usuário sem autorização. Entre em contato com o administrador.';
const FORBIDDEN_CODES = new Set(['FORBIDDEN', 'INSUFFICIENT_PERMISSIONS', 'READ_ONLY_ROLE']);
const FORBIDDEN_GENERIC = /^(acesso negado|voc[êe] n[ãa]o tem permiss[ãa]o para realizar esta a[çc][ãa]o|perfil somente leitura n[ãa]o executa esta a[çc][ãa]o)\.?$/i;

export function apiErrorMessage(data: any, fallback = 'Erro desconhecido'): string {
  if (!data) return fallback;
  const text = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : '';
  if (FORBIDDEN_CODES.has(data.code) || (text && FORBIDDEN_GENERIC.test(text.trim()))) return NO_PERMISSION_MESSAGE;
  if (typeof data.message === 'string' && (typeof data.error !== 'string' || GENERIC_HTTP_ERROR.test(data.error) || MACHINE_CODE.test(data.error))) {
    return readableValidationMessage(data.message);
  }
  if (typeof data.error === 'string') return readableValidationMessage(data.error);
  if (typeof data.message === 'string') return readableValidationMessage(data.message);
  return fallback;
}

// Chamadas de autenticação NUNCA passam pelo "renovar e repetir": um 401 de /auth/login é senha
// errada (não sessão expirada) — antes disparava refresh sem token, deslogava e recarregava a página,
// e o operador nunca via o motivo.
const AUTH_PATHS = ['/api/auth/login', '/api/auth/verify-mfa', '/api/auth/refresh', '/api/auth/logout'];

// Renovação compartilhada (single-flight): com várias requisições em 401 ao mesmo tempo, cada uma
// renovava por conta própria; a API rotaciona o refresh a cada uso, então a 2ª reapresentava um token
// já revogado e a API interpretava como roubo, revogando TODAS as sessões do operador.
let refreshInFlight: Promise<string> | null = null;
function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { refreshToken } = useAuthStore.getState();
      if (!refreshToken) throw new Error('Sessão expirada');
      const response = await axios.post(`${API_URL}/api/auth/refresh`, { refreshToken });
      const { accessToken, refreshToken: rotated } = response.data;
      // guarda o refresh ROTACIONADO (o antigo já foi revogado pela API)
      useAuthStore.getState().setTokens(accessToken, rotated ?? refreshToken);
      return accessToken as string;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Identidade do equipamento para o login e a trava de sessão única (ver comentário em login() abaixo). Antes era o MAC/hostname — um
// texto que qualquer máquina pode repetir. Agora é o id + a CHAVE secreta recebidos no registro (device-enrollment.ts) e autorizados
// pelo administrador: o servidor só abre sessão para equipamento ATIVO com a chave certa. Fora do Electron (dev no navegador comum)
// não há identidade e o login segue sem equipamento (o servidor recusa se a política da empresa exigir).
async function getDeviceCredentials(): Promise<{ deviceId: string; deviceKey: string } | null> {
  if (!window.electron) return null;
  return getDeviceIdentity();
}

class ApiService {
  private api: AxiosInstance;

  constructor() {
    this.api = axios.create({
      baseURL: API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor - adicionar token
    this.api.interceptors.request.use(
      (config) => {
        const token = useAuthStore.getState().token;
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor - tratar erros e refresh token
    this.api.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest: any = error.config;

        // Token expirado - renovar (compartilhado) e repetir. Nunca para as próprias chamadas de auth.
        const isAuthCall = AUTH_PATHS.some((p) => String(originalRequest?.url || '').includes(p));
        if (error.response?.status === 401 && !originalRequest._retry && !isAuthCall) {
          originalRequest._retry = true;

          try {
            const accessToken = await refreshAccessToken();
            originalRequest.headers.Authorization = `Bearer ${accessToken}`;
            return this.api(originalRequest);
          } catch (refreshError) {
            // Sessão irrecuperável: limpa a sessão. Sem redirecionamento manual — o roteador em uso
            // (HashRouter sob file://, BrowserRouter sob http) NÃO é conhecido aqui, e o PrivateRoute
            // (App.tsx) assina o auth store: `isAuthenticated=false` já o leva a /login, sem recarregar.
            useAuthStore.getState().logout();
            return Promise.reject(refreshError);
          }
        }

        // Tratar outros erros. Falha SEM `error.response` (não é um erro
        // HTTP com status — é a requisição nunca tendo saído/voltado) é uma
        // queda de rede real, não um erro de negócio; venda/pagamento/caixa
        // nunca são enfileirados para tentar depois (ver offline.service.ts
        // — só busca de produto/cliente tem fallback de cache), então o
        // operador precisa de uma mensagem inequívoca de que a operação NÃO
        // foi concluída, em vez do texto genérico do axios ("Network Error").
        const isNetworkFailure = !error.response;
        const message = isNetworkFailure
          ? 'Sem conexão com o servidor — a operação NÃO foi concluída. Verifique a rede e tente novamente.'
          : apiErrorMessage(error.response?.data, error.message || 'Erro desconhecido');
        // `quietStatuses`: status que, NESTA chamada, são um resultado esperado tratado por quem
        // chamou (ex.: 404 ao tentar o termo como código antes de buscar por nome; 404 "sem caixa
        // aberto") — não são uma falha para o operador e não devem piscar um toast de erro.
        const status = error.response?.status;
        // `quietNetwork`: a tela que chamou mostra o estado "não confirmado" com a ação certa (sem toast repetido).
        const quiet =
          (status !== undefined && (originalRequest?.quietStatuses as number[] | undefined)?.includes(status)) ||
          (isNetworkFailure && originalRequest?.quietNetwork === true);
        if (status !== 401 && !quiet) {
          toast.error(message);
        }

        return Promise.reject(error);
      }
    );
  }

  // ============================================
  // AUTH
  // ============================================

  async login(numericId: string, password: string) {
    // ACHADO DE AUDITORIA DE INTEGRAÇÃO: a regra "mesmo operador não pode
    // estar logado em dois PDVs ao mesmo tempo" já está implementada e
    // correta no backend (device-session.service.ts, com índices únicos
    // parciais no Postgres — garantia real no banco, não só checagem de
    // aplicação), mas `startDeviceSession` só roda quando o login informa
    // `deviceId` (auth.service.ts). O PDV nunca enviava esse campo, então a
    // trava, embora pronta, nunca era ativada por um login real feito
    // aqui — o mesmo operador podia logar em dois PDVs sem bloqueio nenhum.
    // window.electron.getDeviceInfo() já existe (usado em SettingsPage),
    // só nunca tinha sido conectado ao fluxo de login.
    const device = await getDeviceCredentials();
    const response = await this.api.post('/api/auth/login', {
      numericId: parseInt(numericId),
      password,
      ...(device && { deviceId: device.deviceId, deviceKey: device.deviceKey }),
    });
    return response.data;
  }

  // Segunda etapa do login (usuário com MFA). O `mfaToken` já carrega o equipamento (deviceId) informado no
  // /auth/login, então a sessão de equipamento (MAC) é aberta igual ao login sem MFA. Erros são explicados na
  // própria tela de login (código errado, expirado) — sem toast genérico em inglês.
  async verifyMfa(mfaToken: string, code: string, method: 'totp' | 'backup') {
    const response = await this.api.post('/api/auth/verify-mfa', { mfaToken, code, method }, {
      quietStatuses: [400, 401, 409, 429],
      quietNetwork: true,
    } as any);
    return response.data;
  }

  async logout() {
    // ACHADO DE AUDITORIA DE INTEGRAÇÃO: /auth/logout exige `refreshToken`
    // no corpo (400 Bad Request sem ele — precisa dele para revogar a
    // sessão/refresh token no banco, ver auth.routes.ts) — mesma classe de
    // bug já corrigida em admin-web. Esta chamada nunca enviava nada, então
    // nenhum logout do PDV revogava de fato a sessão no servidor (o refresh
    // token continuava válido até expirar sozinho, e a DeviceSession, se
    // ativa, nunca era encerrada).
    const refreshToken = useAuthStore.getState().refreshToken;
    try {
      if (refreshToken) {
        await this.api.post('/api/auth/logout', { refreshToken });
      }
    } catch (error) {
      console.error('Logout error:', error);
    }
  }

  // ============================================
  // PRODUCTS
  // ============================================

  async searchProducts(search?: string, categoryId?: string, page = 1, limit = 20) {
    const cacheKey = `${search || ''}:${categoryId || ''}:${page}:${limit}`;
    try {
      const response = await this.api.get('/api/products', {
        // isActive: produto desativado no cadastro não é vendável — não aparece na busca do PDV
        params: { search, categoryId, page, limit, isActive: true },
      });
      // Cacheado só em caso de sucesso online — nunca sobrescreve o cache
      // com um resultado incompleto/de erro.
      offlineService.cacheData('products', cacheKey, response.data, 60).catch(() => {});
      return response.data;
    } catch (error) {
      if (!navigator.onLine) {
        const cached = await offlineService.getCachedData('products', cacheKey);
        if (cached) {
          toast('Sem conexão — mostrando resultado salvo localmente', { icon: '📦' });
          return cached;
        }
      }
      throw error;
    }
  }

  async getProductByCode(code: string) {
    try {
      // 404 = "não é um código": o POS cai para a busca por nome, sem toast de erro
      const response = await this.api.get(`/api/products/search/${encodeURIComponent(code)}`, {
        quietStatuses: [404],
      } as any);
      offlineService.cacheData('products', `code:${code}`, response.data, 60).catch(() => {});
      return response.data;
    } catch (error) {
      if (!navigator.onLine) {
        const cached = await offlineService.getCachedData('products', `code:${code}`);
        if (cached) {
          toast('Sem conexão — produto encontrado no cache local', { icon: '📦' });
          return cached;
        }
      }
      throw error;
    }
  }

  async getProductStock(productId: string, branchId?: string) {
    const response = await this.api.get(`/api/products/${productId}/stock`, {
      params: { branchId },
    });
    return response.data;
  }

  // ============================================
  // CUSTOMERS
  // ============================================

  async searchCustomers(search?: string) {
    const cacheKey = search || '';
    try {
      const response = await this.api.get('/api/customers', {
        params: { search, limit: 10 },
      });
      offlineService.cacheData('customers', cacheKey, response.data, 60).catch(() => {});
      return response.data;
    } catch (error) {
      if (!navigator.onLine) {
        const cached = await offlineService.getCachedData('customers', cacheKey);
        if (cached) {
          toast('Sem conexão — mostrando clientes salvos localmente', { icon: '📦' });
          return cached;
        }
      }
      throw error;
    }
  }

  async createCustomer(data: any) {
    const response = await this.api.post('/api/customers', data);
    return response.data;
  }

  // ============================================
  // PARTNERS (Convênios)
  // ============================================

  async getPartners(branchId?: string) {
    const response = await this.api.get('/api/partners', { params: { branchId } });
    // Rota nova (padrão {success,data}) — ver TASK-010 sobre a inconsistência
    // de formato entre rotas antigas/novas do backend.
    return response.data.data;
  }

  // ============================================
  // SALES
  // ============================================

  // `idempotencyKey`: reenvio da MESMA venda após falta de resposta devolve a venda já criada (sem duplicar).
  // `quiet`: status que quem chamou trata e mostra na própria tela (sem toast duplicado).
  async createSale(data: any, opts: { idempotencyKey?: string; quiet?: number[] } = {}) {
    // 409 é silenciado aqui para o pedido de autorização de desconto não piscar um toast de erro; os demais 409
    // continuam sendo mostrados (abaixo), a menos que quem chamou os trate.
    const quiet = [...(opts.quiet ?? []), 409];
    try {
      const response = await this.api.post('/api/sales', data, {
        ...(opts.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
        quietStatuses: quiet,
      } as any);
      return response.data;
    } catch (error: any) {
      const body = error?.response?.data;
      if (error?.response?.status === 409 && body?.code === 'DISCOUNT_AUTHORIZATION_REQUIRED' && !data?.discountAuthorizerNumericId) {
        return this.createSaleWithDiscountAuthorization(data, body, opts);
      }
      if (error?.response?.status === 409 && !opts.quiet?.includes(409)) toast.error(apiErrorMessage(body));
      throw error;
    }
  }

  /**
   * Desconto acima do limite livre (docs/CORTEX/policies/DESCONTO.md): pede motivo + credenciais de um gerente/
   * administrador (DiscountAuthorizationDialog) e reenvia a MESMA venda com a autorização — com chave de idempotência
   * nova (o corpo mudou). Autorizador recusado → mostra o motivo no próprio diálogo e pede de novo. Cancelar → a venda
   * não é registrada.
   */
  private async createSaleWithDiscountAuthorization(data: any, first: any, opts: { idempotencyKey?: string; quiet?: number[] }) {
    let lastError: string | undefined;
    let lastReason: string | undefined;
    for (let attempt = 1; ; attempt++) {
      const answer = await requestDiscountAuthorization({ details: first.details, message: apiErrorMessage(first), error: lastError, reason: lastReason });
      if (!answer) {
        toast.error('Desconto não autorizado: a venda não foi registrada. Ajuste o desconto ou peça a autorização.');
        const cancelled: any = new Error('Desconto não autorizado');
        cancelled.code = 'DISCOUNT_AUTHORIZATION_CANCELLED';
        throw cancelled;
      }
      lastReason = answer.reason;
      const body = {
        ...data,
        discountReason: answer.reason,
        discountAuthorizerNumericId: parseInt(answer.numericId, 10),
        discountAuthorizerPassword: answer.password,
        discountAuthorizerMfaCode: answer.mfaCode || undefined,
      };
      const key = `${opts.idempotencyKey ?? `PDV-SALE-${Date.now()}`}-auth-${attempt}`;
      try {
        const response = await this.api.post('/api/sales', body, { headers: { 'Idempotency-Key': key }, quietStatuses: [400, 403] } as any);
        toast.success('Desconto autorizado');
        return response.data;
      } catch (error: any) {
        const status = error?.response?.status;
        if (status === 400 || status === 403) {
          lastError = apiErrorMessage(error.response.data, 'Autorização recusada');
          continue;
        }
        throw error;
      }
    }
  }

  async getSales(filters?: any) {
    const response = await this.api.get('/api/sales', { params: filters });
    return response.data;
  }

  async getSaleById(id: string) {
    const response = await this.api.get(`/api/sales/${id}`);
    return response.data;
  }

  // Cancelamento de venda já finalizada exige dupla autorização: um segundo
  // usuário (gerência+) informa as PRÓPRIAS credenciais (numericId + senha +
  // MFA se habilitado) na mesma chamada — ver sale.service.ts#cancelSale e
  // dual-authorization.service.ts. userId do requisitante NÃO é enviado
  // aqui: o backend deriva quem está pedindo da sessão autenticada.
  async cancelSale(
    id: string,
    data: {
      reason: string;
      authorizerNumericId: number;
      authorizerPassword: string;
      authorizerMfaCode?: string;
    }
  ) {
    const response = await this.api.post(`/api/sales/${id}/cancel`, data);
    return response.data;
  }

  async returnSale(
    id: string,
    data: {
      reason: string;
      items?: Array<{ saleItemId: string; quantity: number }>;
      authorizerNumericId: number;
      authorizerPassword: string;
      authorizerMfaCode?: string;
    }
  ) {
    const response = await this.api.post(`/api/sales/${id}/return`, data);
    return response.data;
  }

  async getSalesStats(branchId?: string, startDate?: string, endDate?: string) {
    const response = await this.api.get('/api/sales/stats', {
      params: { branchId, startDate, endDate },
    });
    return response.data;
  }

  // ============================================
  // CASH REGISTER
  // ============================================

  async openCashRegister(data: any) {
    const response = await this.api.post('/api/cash-register/open', data);
    return response.data;
  }

  // 409 CASH_CLOSE_PENDING (pendências + política) é tratado pelo modal de fechamento, que mostra a lista.
  async closeCashRegister(id: string, data: any) {
    // 400 (diferença sem motivo, soma por forma) e 409 (pendências) são mostrados pelo próprio modal, uma vez só.
    const response = await this.api.post(`/api/cash-register/${id}/close`, data, { quietStatuses: [400, 409] } as any);
    return response.data;
  }

  // Pendências do caixa (pagamentos não confirmados, vendas em aberto) e se o fechamento normal está bloqueado.
  async getCashRegisterPendencies(id: string) {
    const response = await this.api.get(`/api/cash-register/${id}/pendencies`, { quietStatuses: [403, 404] } as any);
    return response.data;
  }

  // Fechamento FORÇADO (gerente/administrador, ou operador com as credenciais de um deles): motivo obrigatório.
  async forceCloseCashRegister(
    id: string,
    data: {
      actualAmount: number;
      reason: string;
      notes?: string;
      declaredByMethod?: Record<string, number>;
      differenceReason?: string;
      authorizerNumericId?: number;
      authorizerPassword?: string;
      authorizerMfaCode?: string;
    }
  ) {
    const response = await this.api.post(`/api/cash-register/${id}/force-close`, data, {
      headers: { 'Idempotency-Key': `PDV-FORCE-CLOSE-${id}-${Date.now()}` },
      quietStatuses: [400, 403, 409],
    } as any);
    return response.data;
  }

  async getCurrentCashRegister(branchId?: string) {
    // 404 = "nenhum caixa aberto" (estado normal antes de abrir/depois de fechar): o chamador trata
    const response = await this.api.get('/api/cash-register/current', {
      params: { branchId },
      quietStatuses: [404],
    } as any);
    return response.data;
  }

  // ACHADO DE AUDITORIA DE INTEGRAÇÃO: a rota real é POST
  // /api/cash-register/movement (sem segmento :id — cashRegisterId vai no
  // corpo), não POST /api/cash-register/:id/movement — esta chamada sempre
  // devolvia 404. Além disso o backend só aceita movementType='DEPOSIT'
  // aqui (WITHDRAWAL exige a rota dedicada de dupla autorização, ver
  // requestWithdrawal), então fixamos isso explicitamente em vez de deixar
  // o chamador ter que saber da regra. Nenhuma tela chamava este método
  // ainda (função morta, apesar da própria página já convidar o operador a
  // "registrar sangrias e reforços") — corrigido junto com o botão/modal de
  // Reforço de Caixa em CashRegisterPage.tsx.
  // `idempotencyKey`: a MESMA chave por reforço digitado — reenvio (Enter repetido, rede lenta) não lança duas vezes.
  // Erro: o toast é o do interceptor (a tela não mostra outro).
  async addCashMovement(cashRegisterId: string, data: { amount: number; notes?: string; idempotencyKey?: string }) {
    const response = await this.api.post(
      '/api/cash-register/movement',
      {
        cashRegisterId,
        movementType: 'DEPOSIT',
        amount: data.amount,
        notes: data.notes,
      },
      data.idempotencyKey ? { headers: { 'Idempotency-Key': data.idempotencyKey } } : undefined
    );
    return response.data;
  }

  // Retirada de caixa (sangria) com dupla autorização — rota dedicada,
  // POST /movement agora rejeita WITHDRAWAL (só aceita DEPOSIT). O
  // autorizador (segundo usuário, gerência+) informa as próprias
  // credenciais na mesma chamada. Ver cash-register.service.ts#requestWithdrawal.
  async requestWithdrawal(
    id: string,
    data: {
      amount: number;
      reason: string;
      authorizerNumericId: number;
      authorizerPassword: string;
      authorizerMfaCode?: string;
    }
  ) {
    const response = await this.api.post(`/api/cash-register/${id}/withdrawal`, data);
    return response.data;
  }

  async getCashRegisterHistory(filters?: any) {
    const response = await this.api.get('/api/cash-register/history', { params: filters });
    return response.data;
  }

  // ============================================
  // PAYMENTS
  // ============================================

  async getPaymentSettings(): Promise<{ cashDenominationControl: boolean; source: string }> {
    const response = await this.api.get('/api/payment-settings');
    return response.data;
  }

  async sendTelemetry(data: Record<string, unknown>) {
    const response = await this.api.post('/api/telemetry', data);
    return response.data;
  }

  /** Latência até a API (ms) numa chamada sem autenticação; null = falhou. */
  async pingApi(timeoutMs = 5000): Promise<number | null> {
    const started = performance.now();
    try {
      await axios.get(`${API_URL}/api/health/live`, { timeout: timeoutMs });
      return Math.round(performance.now() - started);
    } catch {
      return null;
    }
  }

  // "Relatar problema" (docs/CORTEX/SUPPORT.md): empresa/filial/usuário vêm do token. `Idempotency-Key` fixa por
  // tela aberta — reenviar após falta de resposta devolve o mesmo chamado em vez de abrir outro. Erros ficam no modal.
  async createSupportTicket(body: Record<string, unknown>, idempotencyKey: string) {
    const version = typeof __CORTEX_APP_VERSION__ !== 'undefined' ? __CORTEX_APP_VERSION__ : undefined;
    const response = await this.api.post('/api/support/tickets', body, {
      headers: { 'Idempotency-Key': idempotencyKey, 'X-Client-Source': 'PDV', ...(version ? { 'X-App-Version': version } : {}) },
      quietStatuses: [400, 403, 404, 409, 422, 429, 500, 502, 503, 504],
    } as any);
    return response.data as { id: string; ticketNumber: number };
  }

  // Cabeçalho `Idempotency-Key` (+ `transactionId` igual no corpo): a mesma tentativa reenviada nunca cobra duas vezes.
  // Os erros são mostrados no painel de estado do pagamento (PaymentModal), então nenhum status gera toast aqui.
  async processPayment(data: any, idempotencyKey?: string) {
    const response = await this.api.post('/api/payments', data, {
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      quietStatuses: [400, 403, 404, 409, 422, 500, 502, 503, 504],
      quietNetwork: true,
    } as any);
    return response.data;
  }

  /** Consulta o provedor de novo (gerência+). Operador usa getPaymentStatus. */
  async reconcilePayment(id: string) {
    const response = await this.api.post(`/api/payments/${id}/reconcile`, {}, { quietStatuses: [400, 403, 404, 409] } as any);
    return response.data;
  }

  /** Cancela um pagamento PENDENTE (exige permissão de estorno — 403 para quem não tem). */
  async cancelPayment(id: string) {
    const response = await this.api.post(`/api/payments/${id}/cancel`, {}, { quietStatuses: [400, 403, 404, 409] } as any);
    return response.data;
  }

  // Políticas efetivas da filial (ex.: convênio de funcionário/empresa ligado). Falha = políticas desconhecidas.
  async getEffectivePolicies(): Promise<{ values: Record<string, any> }> {
    const response = await this.api.get('/api/policies/effective', { quietStatuses: [403, 404] } as any);
    return response.data;
  }

  // Convênios (contrato do módulo de convênios): busca por nome/CPF/matrícula ou razão/fantasia/CNPJ.
  async lookupEmployeeAgreements(q: string) {
    const response = await this.api.get('/api/employee-agreements/lookup', { params: { q }, quietStatuses: [400, 403, 404] } as any);
    return (Array.isArray(response.data) ? response.data : response.data?.data ?? []) as any[];
  }

  async lookupAgreementCompanies(q: string) {
    const response = await this.api.get('/api/agreement-companies/lookup', { params: { q }, quietStatuses: [400, 403, 404] } as any);
    return (Array.isArray(response.data) ? response.data : response.data?.data ?? []) as any[];
  }

  async getPaymentStatus(transactionId: string) {
    // A rota do backend é GET /api/payments/transaction/:transactionId
    // (não GET /api/payments/:transactionId, que não existe) — sem o
    // segmento "/transaction" essa chamada sempre retornava 404.
    const response = await this.api.get(`/api/payments/transaction/${encodeURIComponent(transactionId)}`, {
      quietStatuses: [404],
      quietNetwork: true,
    } as any);
    return response.data;
  }
}

export const api = new ApiService();
