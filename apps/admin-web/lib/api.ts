import axios, { AxiosInstance } from 'axios';
import type { QuoteItemPayload } from './quotes';
import type { ManagementSummary, ManagementTimeseries } from './dashboard-management';
import type { ChannelCredentialView, ChannelOrderView, OutboxRowView, SalesChannelView } from './sales-channels';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
const REFRESH_TOKEN_KEY = 'refreshToken';

class ApiClient {
  private client: AxiosInstance;
  // ACHADO DE AUDITORIA DE INTEGRAÇÃO: diferente de apps/mobile e apps/tv
  // (que persistem o refreshToken e fazem refresh silencioso em single-flight
  // no 401 — ver src/api/client.ts de ambos), admin-web descartava o
  // refreshToken devolvido por /auth/login e simplesmente deslogava em
  // qualquer 401, mesmo um access token só expirado por tempo (15min) no
  // meio de uma tela aberta o dia inteiro. Mesmo padrão de coalescing usado
  // lá: sem ele, um burst de chamadas paralelas no exato momento da
  // expiração dispararia vários /auth/refresh ao mesmo tempo, e o 2º
  // chegaria com um refreshToken já rotacionado pelo 1º — falharia à toa.
  private refreshingPromise: Promise<string | null> | null = null;

  /**
   * Cliente HTTP com a mesma autenticação/renovação/tratamento de erro deste arquivo, para os módulos de domínio em
   * `lib/api/*.ts` (políticas, garantia, convênios…) — cada área tem seu arquivo em vez de crescer este.
   */
  get http(): AxiosInstance {
    return this.client;
  }

  constructor() {
    this.client = axios.create({
      baseURL: API_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Interceptor para adicionar token
    this.client.interceptors.request.use(
      (config) => {
        const token = localStorage.getItem('token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Interceptor para tratar erros
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const original = error.config;
        // Chamadas de autenticação (login, código MFA, refresh, logout): o 401 delas é senha/código
        // ERRADO, não sessão expirada. Antes caíam no "limpa tudo e recarrega /login": o formulário
        // esvaziava e o usuário nunca via o motivo (reproduzido na tela, senha errada e código MFA errado).
        const isAuthCall = /\/auth\/(login|verify-mfa|mfa-enrollment|refresh|logout)/.test(String(original?.url || ''));
        if (error.response?.status === 401 && original && !original._retry && !isAuthCall) {
          original._retry = true;
          const newAccessToken = await this.tryRefresh();
          if (newAccessToken) {
            original.headers.Authorization = `Bearer ${newAccessToken}`;
            return this.client(original);
          }
        }
        if (error.response?.status === 401 && !isAuthCall) {
          localStorage.removeItem('token');
          localStorage.removeItem(REFRESH_TOKEN_KEY);
          if (window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
        }
        return Promise.reject(error);
      }
    );
  }

  private async tryRefresh(): Promise<string | null> {
    if (!this.refreshingPromise) {
      this.refreshingPromise = (async () => {
        try {
          const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
          if (!refreshToken) return null;
          const { data } = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
          localStorage.setItem('token', data.accessToken);
          localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
          return data.accessToken as string;
        } catch {
          return null;
        } finally {
          this.refreshingPromise = null;
        }
      })();
    }
    return this.refreshingPromise;
  }

  // Products
  async getProducts(params?: any) {
    const { data } = await this.client.get('/products', { params });
    return data;
  }

  async getProduct(id: string) {
    const { data } = await this.client.get(`/products/${id}`);
    return data;
  }

  async createProduct(product: any) {
    const { data } = await this.client.post('/products', product);
    return data;
  }

  async updateProduct(id: string, product: any) {
    const { data } = await this.client.put(`/products/${id}`, product);
    return data;
  }

  async deleteProduct(id: string) {
    const { data } = await this.client.delete(`/products/${id}`);
    return data;
  }

  async importProducts(products: any[]) {
    // ACHADO (auditoria frontend↔backend): apontava para '/products/import',
    // que não existe — a rota real de importação em lote é '/import/products'
    // (apps/api/src/routes/import.routes.ts, montada em /import). Todo
    // import de produtos pela UI sempre falhava com 404.
    const { data } = await this.client.post('/import/products', { products });
    return data;
  }

  // Estoque: importação em lote via Excel/CSV (SKU/código de barras -> quantidade).
  // Confere quais linhas casam com produtos existentes ANTES da importação —
  // não cria nenhuma movimentação, só faz a checagem.
  async previewStockImport(items: Array<{ sku?: string; barcode?: string }>) {
    const { data } = await this.client.post('/stock/import/preview', { items });
    return data;
  }

  // Cria uma movimentação de ajuste de estoque (ADJUSTMENT) por linha casada.
  // O backend reporta exatamente o que teve sucesso e o que falhou por linha
  // (nunca reporta "tudo importado" se algo falhou).
  async importStock(stockItems: Array<{ sku?: string; barcode?: string; quantity: number; reason?: string }>) {
    const { data } = await this.client.post('/import/stock', { stockItems });
    return data;
  }

  // Customers
  async getCustomers(params?: any) {
    const { data } = await this.client.get('/customers', { params });
    return data;
  }

  async getCustomer(id: string) {
    const { data } = await this.client.get(`/customers/${id}`);
    return data;
  }

  async createCustomer(customer: any) {
    const { data } = await this.client.post('/customers', customer);
    return data;
  }

  async updateCustomer(id: string, customer: any) {
    const { data } = await this.client.put(`/customers/${id}`, customer);
    return data;
  }

  async deleteCustomer(id: string) {
    const { data } = await this.client.delete(`/customers/${id}`);
    return data;
  }

  async importCustomers(customers: any[]) {
    // Same fix as importProducts — real route is '/import/customers'.
    const { data } = await this.client.post('/import/customers', { customers });
    return data;
  }

  // Sales
  async getSales(params?: any) {
    const { data } = await this.client.get('/sales', { params });
    return data;
  }

  async getSale(id: string) {
    const { data } = await this.client.get(`/sales/${id}`);
    return data;
  }

  // Dashboard
  async getDashboardStats() {
    const { data } = await this.client.get('/dashboard/stats');
    return data;
  }

  // Categories
  async getCategories() {
    const { data } = await this.client.get('/categories');
    return data;
  }

  async createCategory(category: any) {
    const { data } = await this.client.post('/categories', category);
    return data;
  }

  // Auth
  async login(email: string, password: string) {
    const { data } = await this.client.post('/auth/login', { email, password });
    return data;
  }

  // Desafio de MFA NO LOGIN (mfaToken temporário devolvido por /auth/login
  // quando o usuário tem MFA ativo) — não confundir com verifyMfa() (linha
  // ~981), que confirma o CADASTRO de um MFA novo já autenticado, contra um
  // endpoint diferente (/mfa/verify, sem mfaToken).
  async verifyLoginMfa(mfaToken: string, code: string, method: 'totp' | 'backup' = 'totp') {
    const { data } = await this.client.post('/auth/verify-mfa', { mfaToken, code, method });
    return data;
  }

  // Configuração OBRIGATÓRIA do MFA (decisão 123): a credencial vem do 403 MFA_ENROLLMENT_REQUIRED do login.
  async beginMfaEnrollment(enrollmentToken: string) {
    const { data } = await this.client.post('/auth/mfa-enrollment/begin', { enrollmentToken });
    return data as { success: boolean; data: { secret: string; otpauthUrl: string } };
  }

  async confirmMfaEnrollment(enrollmentToken: string, code: string) {
    const { data } = await this.client.post('/auth/mfa-enrollment/confirm', { enrollmentToken, code });
    return data as { accessToken: string; refreshToken: string; backupCodes: string[] };
  }

  // Troca da SENHA TEMPORÁRIA no primeiro acesso (decisão 157): a credencial vem do 403 PASSWORD_CHANGE_REQUIRED do login (ou do verify-mfa).
  async completePasswordChange(passwordChangeToken: string, currentPassword: string, newPassword: string) {
    const { data } = await this.client.post('/auth/password-change/complete', { passwordChangeToken, currentPassword, newPassword });
    return data as { success: boolean; message: string };
  }

  // Troca voluntária da própria senha, com sessão (encerra todas as sessões da conta: é preciso entrar de novo).
  async changeOwnPassword(currentPassword: string, newPassword: string) {
    const { data } = await this.client.post('/auth/change-password', { currentPassword, newPassword });
    return data as { success: boolean; message: string };
  }

  async logout() {
    // ACHADO DE AUDITORIA DE INTEGRAÇÃO: /auth/logout exige `refreshToken`
    // no corpo (400 Bad Request sem ele — ver auth.routes.ts) para poder
    // revogá-lo no banco; esta chamada nunca enviava nada, então nenhum
    // logout pelo admin-web jamais revogou de fato uma sessão no servidor
    // (o refresh token continuava válido até expirar sozinho). Também não
    // havia nenhum botão no admin-web chamando este método (ver Header.tsx).
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    try {
      if (refreshToken) {
        await this.client.post('/auth/logout', { refreshToken });
      }
    } finally {
      localStorage.removeItem('token');
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  }

  async getMe() {
    const { data } = await this.client.get('/auth/me');
    return data;
  }

  // Customer search (quick search for pickers)
  async searchCustomers(search: string, limit?: number) {
    const { data } = await this.client.get('/customers/search', {
      params: { search, limit },
    });
    return data;
  }

  // Motorcycles
  async getMotorcycles(params?: any) {
    const { data } = await this.client.get('/motorcycles', { params });
    return data;
  }

  async getMotorcycle(id: string) {
    const { data } = await this.client.get(`/motorcycles/${id}`);
    return data;
  }

  async createMotorcycle(motorcycle: any) {
    const { data } = await this.client.post('/motorcycles', motorcycle);
    return data;
  }

  async updateMotorcycle(id: string, motorcycle: any) {
    const { data } = await this.client.put(`/motorcycles/${id}`, motorcycle);
    return data;
  }

  async deleteMotorcycle(id: string) {
    const { data } = await this.client.delete(`/motorcycles/${id}`);
    return data;
  }

  // Branches
  async getBranches(params?: any) {
    const { data } = await this.client.get('/branches', { params });
    return data;
  }

  async getBranch(id: string) {
    const { data } = await this.client.get(`/branches/${id}`);
    return data;
  }

  // Só SUPER_ADMIN (a API responde 403 aos demais): escolher a empresa ao criar filial.
  async getCompanies() {
    const { data } = await this.client.get('/companies');
    return data;
  }

  async createBranch(branch: any) {
    const { data } = await this.client.post('/branches', branch);
    return data;
  }

  async updateBranch(id: string, branch: any) {
    const { data } = await this.client.put(`/branches/${id}`, branch);
    return data;
  }

  async toggleBranchActive(id: string) {
    const { data } = await this.client.post(`/branches/${id}/toggle-active`);
    return data;
  }

  async deleteBranch(id: string) {
    const { data } = await this.client.delete(`/branches/${id}`);
    return data;
  }

  // Suppliers
  async getSuppliers(params?: any) {
    const { data } = await this.client.get('/suppliers', { params });
    return data;
  }

  async getSupplier(id: string) {
    const { data } = await this.client.get(`/suppliers/${id}`);
    return data;
  }

  async createSupplier(supplier: any) {
    const { data } = await this.client.post('/suppliers', supplier);
    return data;
  }

  async updateSupplier(id: string, supplier: any) {
    const { data } = await this.client.put(`/suppliers/${id}`, supplier);
    return data;
  }

  async deleteSupplier(id: string) {
    const { data } = await this.client.delete(`/suppliers/${id}`);
    return data;
  }

  // Convênios/Parceiros (desconto nomeado no PDV — ver GET/POST/PUT/DELETE
  // /api/partners) — resposta no formato {success, data}, diferente do
  // formato usado por /suppliers ({suppliers: [...]}) — inconsistência entre rotas antigas/novas
  // (TASK-010 do quadro de tarefas original, que não está no repositório).
  async getPartners(branchId?: string) {
    const { data } = await this.client.get('/partners', { params: branchId ? { branchId } : undefined });
    return data.data;
  }

  async createPartner(partner: any) {
    const { data } = await this.client.post('/partners', partner);
    return data.data;
  }

  async updatePartner(id: string, partner: any) {
    const { data } = await this.client.put(`/partners/${id}`, partner);
    return data.data;
  }

  async deletePartner(id: string) {
    const { data } = await this.client.delete(`/partners/${id}`);
    return data;
  }

  async togglePartnerActive(id: string) {
    const { data } = await this.client.post(`/partners/${id}/toggle-active`);
    return data.data;
  }

  // Política de parcelamento por empresa/filial/forma de pagamento — ver
  // GET/POST/PUT/DELETE /api/installment-policies.
  async getInstallmentPolicies() {
    const { data } = await this.client.get('/installment-policies');
    return data.data;
  }

  async createInstallmentPolicy(policy: any) {
    const { data } = await this.client.post('/installment-policies', policy);
    return data.data;
  }

  async updateInstallmentPolicy(id: string, policy: any) {
    const { data } = await this.client.put(`/installment-policies/${id}`, policy);
    return data.data;
  }

  async deleteInstallmentPolicy(id: string) {
    const { data } = await this.client.delete(`/installment-policies/${id}`);
    return data;
  }

  // Purchase Orders
  async getPurchaseOrders(params?: any) {
    const { data } = await this.client.get('/purchase-orders', { params });
    return data;
  }

  async getPurchaseOrder(id: string) {
    const { data } = await this.client.get(`/purchase-orders/${id}`);
    return data;
  }

  async createPurchaseOrder(purchaseOrder: any) {
    const { data } = await this.client.post('/purchase-orders', purchaseOrder);
    return data;
  }

  async approvePurchaseOrder(id: string) {
    const { data } = await this.client.post(`/purchase-orders/${id}/approve`);
    return data;
  }

  async cancelPurchaseOrder(id: string) {
    const { data } = await this.client.post(`/purchase-orders/${id}/cancel`);
    return data;
  }

  async receivePurchaseOrder(id: string, payload: any) {
    const { data } = await this.client.post(`/purchase-orders/${id}/receive`, payload);
    return data;
  }

  // Sales stats (used by Sales and Dashboard pages)
  async getSalesStats(params?: any) {
    const { data } = await this.client.get('/sales/stats', { params });
    return data;
  }

  // Cancelar venda exige DUPLA AUTORIZAÇÃO (sale.service.ts): um segundo
  // usuário (gerência+) informa as próprias credenciais. Antes o Admin Web
  // mandava só `{ reason }` e a API sempre respondia 400 (cancelSaleSchema).
  // Resposta: `{ success, data: venda }`.
  async cancelSale(
    id: string,
    payload: { reason: string; authorizerNumericId: number; authorizerPassword: string; authorizerMfaCode?: string }
  ) {
    const { data } = await this.client.post(`/sales/${id}/cancel`, payload);
    return data;
  }

  // Users (Settings > Usuários)
  async getUsers(params?: any) {
    const { data } = await this.client.get('/users', { params });
    return data;
  }

  async createUser(user: { name: string; email: string; password: string; userType: string; branchId?: string; requirePasswordChange?: boolean }) {
    const { data } = await this.client.post('/users', user);
    return data.data;
  }

  async updateUser(id: string, user: Partial<{ name: string; email: string; password: string; userType: string; branchId: string }>) {
    const { data } = await this.client.put(`/users/${id}`, user);
    return data.data;
  }

  /** Filiais autorizadas do usuário: a principal + os vínculos adicionais (decisão 153). */
  async getUserBranches(id: string): Promise<{
    userId: string;
    primaryBranchId: string | null;
    extraBranchIds: string[];
    branchIds: string[];
    branches: Array<{ id: string; name: string; primary: boolean }>;
  }> {
    const { data } = await this.client.get(`/users/${id}/branches`);
    return data.data;
  }

  /** Só SUPER_ADMIN/COMPANY_ADMIN gravam (o servidor recusa os demais). Envia a lista de filiais autorizadas; a principal não vira vínculo duplicado. */
  async setUserBranches(id: string, branchIds: string[]) {
    const { data } = await this.client.put(`/users/${id}/branches`, { branchIds });
    return data.data;
  }

  async unlockUser(id: string) {
    const { data } = await this.client.post(`/users/${id}/unlock`);
    return data;
  }

  async resetUserPassword(id: string, password: string, requirePasswordChange = true) {
    const { data } = await this.client.post(`/users/${id}/reset-password`, { password, requirePasswordChange });
    return data;
  }

  async toggleUserActive(id: string) {
    const { data } = await this.client.post(`/users/${id}/toggle-active`);
    return data;
  }

  // RBAC granular — Perfis (Role) e Permissões (Permission). Resposta no
  // formato {success, data}, mesmo caso de /partners e /installment-policies.
  async getRoles() {
    const { data } = await this.client.get('/roles');
    return data.data;
  }

  async createRole(role: { name: string; description?: string }) {
    const { data } = await this.client.post('/roles', role);
    return data.data;
  }

  async deleteRole(id: string) {
    const { data } = await this.client.delete(`/roles/${id}`);
    return data;
  }

  async getPermissions() {
    const { data } = await this.client.get('/permissions');
    return data.data;
  }

  async createPermission(permission: { name: string; description?: string; scope?: string }) {
    const { data } = await this.client.post('/permissions', permission);
    return data.data;
  }

  async deletePermission(id: string) {
    const { data } = await this.client.delete(`/permissions/${id}`);
    return data;
  }

  async assignRolePermission(roleId: string, permissionId: string) {
    const { data } = await this.client.post(`/roles/${roleId}/permissions`, { permissionId });
    return data;
  }

  async revokeRolePermission(roleId: string, permissionId: string) {
    const { data } = await this.client.delete(`/roles/${roleId}/permissions/${permissionId}`);
    return data;
  }

  // Atribuição de perfil a usuário (UserRole) — ver user.routes.ts.
  async getUserRoles(userId: string) {
    const { data } = await this.client.get(`/users/${userId}/roles`);
    return data.data;
  }

  async assignUserRole(userId: string, roleId: string, branchId?: string | null) {
    const { data } = await this.client.post(`/users/${userId}/roles`, { roleId, branchId: branchId ?? null });
    return data;
  }

  async revokeUserRole(userId: string, roleId: string, branchId?: string | null) {
    const { data } = await this.client.delete(`/users/${userId}/roles/${roleId}`, {
      params: branchId ? { branchId } : undefined,
    });
    return data;
  }

  // Backup (Settings > Backup)
  async createBackup() {
    const { data } = await this.client.post('/backup/create');
    return data;
  }

  async listBackups() {
    const { data } = await this.client.get('/backup/list');
    return data;
  }

  async getBackupStats() {
    const { data } = await this.client.get('/backup/stats');
    return data;
  }

  // Dashboard (KPIs por área — GET /api/dashboard/*)
  async getSalesDashboard(params?: { branchId?: string; startDate?: string; endDate?: string }) {
    const { data } = await this.client.get('/dashboard/sales', { params });
    return data;
  }

  async getFinancialDashboard(params?: { branchId?: string; startDate?: string; endDate?: string }) {
    const { data } = await this.client.get('/dashboard/financial', { params });
    return data;
  }

  async getStockDashboard(params?: { branchId?: string; staleDays?: number }) {
    const { data } = await this.client.get('/dashboard/stock', { params });
    return data;
  }

  async getWorkshopDashboard(params?: {
    branchId?: string;
    startDate?: string;
    endDate?: string;
    /** Período único do painel (today, 7d, 30d...; ver lib/dashboard-management.ts): a API resolve em Brasília. */
    period?: string;
    start?: string;
    end?: string;
    overdueDays?: number;
  }) {
    const { data } = await this.client.get('/dashboard/workshop', { params });
    return data;
  }

  // Dashboard gerencial: UMA chamada de resumo e UMA de séries, ambas com o MESMO período (nome do recorte; a API resolve).
  async getManagementSummary(params: { period: string; start?: string; end?: string; branchId?: string }): Promise<ManagementSummary> {
    const { data } = await this.client.get('/dashboard/management/summary', { params });
    return data;
  }

  async getManagementTimeseries(params: { period: string; start?: string; end?: string; branchId?: string }): Promise<ManagementTimeseries> {
    const { data } = await this.client.get('/dashboard/management/timeseries', { params });
    return data;
  }

  // Canais de venda (módulo CANAIS, nasce desativado): administração; a credencial é só escrita (a API nunca a devolve).
  async getSalesChannels(): Promise<{ data: SalesChannelView[] }> {
    const { data } = await this.client.get('/sales-channels');
    return data;
  }

  async createSalesChannel(body: { type: string; displayName: string; branchId?: string | null }): Promise<SalesChannelView> {
    const { data } = await this.client.post('/sales-channels', body);
    return data;
  }

  async updateSalesChannel(id: string, body: { displayName?: string; isActive?: boolean; externalAccountId?: string | null }): Promise<SalesChannelView> {
    const { data } = await this.client.patch(`/sales-channels/${id}`, body);
    return data;
  }

  async setSalesChannelCredentials(id: string, credentials: Record<string, string>): Promise<SalesChannelView> {
    const { data } = await this.client.put(`/sales-channels/${id}/credentials`, { credentials });
    return data;
  }

  async clearSalesChannelCredentials(id: string): Promise<SalesChannelView> {
    const { data } = await this.client.delete(`/sales-channels/${id}/credentials`);
    return data;
  }

  async testSalesChannelConnection(id: string): Promise<{ ok: boolean; reason: string; message: string; channel: SalesChannelView }> {
    const { data } = await this.client.post(`/sales-channels/${id}/test-connection`, {});
    return data;
  }

  async getSalesChannelEvents(id: string): Promise<{ data: Array<{ id: string; type: string; level: string; message: string; createdAt: string }> }> {
    const { data } = await this.client.get(`/sales-channels/${id}/events`);
    return data;
  }

  // Commerce API — administração (credenciais que o canal usa, publicação de produtos e pedidos recebidos).
  async getChannelApiCredentials(id: string): Promise<{ data: ChannelCredentialView[] }> {
    const { data } = await this.client.get(`/sales-channels/${id}/api-credentials`);
    return data;
  }

  /** O segredo vem só nesta resposta e nunca mais. */
  async createChannelApiCredential(id: string, body: { label: string; scopes: string[]; expiresAt?: string | null }): Promise<{ credential: ChannelCredentialView; secret: string }> {
    const { data } = await this.client.post(`/sales-channels/${id}/api-credentials`, body);
    return data;
  }

  async rotateChannelApiCredential(id: string, credentialId: string): Promise<{ credential: ChannelCredentialView; secret: string }> {
    const { data } = await this.client.post(`/sales-channels/${id}/api-credentials/${credentialId}/rotate`, {});
    return data;
  }

  async revokeChannelApiCredential(id: string, credentialId: string): Promise<ChannelCredentialView> {
    const { data } = await this.client.delete(`/sales-channels/${id}/api-credentials/${credentialId}`);
    return data;
  }

  async getChannelProducts(id: string, params: { page?: number; limit?: number; published?: boolean } = {}): Promise<{ data: Array<{ sku: string; name: string; price: number; productActive: boolean; published: boolean }>; pagination: { page: number; limit: number; total: number } }> {
    const { data } = await this.client.get(`/sales-channels/${id}/products`, { params });
    return data;
  }

  async setChannelProductsPublished(id: string, body: { skus: string[]; published: boolean }): Promise<{ updated: number; unknownSkus: string[] }> {
    const { data } = await this.client.put(`/sales-channels/${id}/products`, body);
    return data;
  }

  async getChannelOrders(id: string, params: { status?: string; page?: number; limit?: number } = {}): Promise<{ data: ChannelOrderView[]; pagination: { page: number; limit: number; total: number } }> {
    const { data } = await this.client.get(`/sales-channels/${id}/orders`, { params });
    return data;
  }

  async rejectChannelOrder(id: string, orderId: string, reason: string): Promise<{ data: ChannelOrderView }> {
    const { data } = await this.client.post(`/sales-channels/${id}/orders/${orderId}/reject`, { reason });
    return data;
  }

  async cancelChannelOrder(id: string, orderId: string, reason: string): Promise<{ data: ChannelOrderView }> {
    const { data } = await this.client.post(`/sales-channels/${id}/orders/${orderId}/cancel`, { reason });
    return data;
  }

  async getChannelOutbox(id: string, params: { status?: string; limit?: number } = {}): Promise<{ data: OutboxRowView[]; counts: Record<string, number>; inboundCounts: Record<string, number> }> {
    const { data } = await this.client.get(`/sales-channels/${id}/outbox`, { params });
    return data;
  }

  async retryChannelOutbox(id: string, rowId: string): Promise<{ ok: boolean }> {
    const { data } = await this.client.post(`/sales-channels/${id}/outbox/${rowId}/retry`, {});
    return data;
  }

  async cancelChannelOutbox(id: string, rowId: string): Promise<{ ok: boolean }> {
    const { data } = await this.client.post(`/sales-channels/${id}/outbox/${rowId}/cancel`, {});
    return data;
  }

  /** Enfileira o envio do catálogo publicado ao provedor (estoque disponível, preço ou cadastro). O CÓRTEX é o mestre: só envia. */
  async syncChannel(id: string, kind: 'inventory' | 'price' | 'catalog'): Promise<{ data: { items: number; batches: number; enqueued: number } }> {
    const { data } = await this.client.post(`/sales-channels/${id}/sync/${kind}`, {});
    return data;
  }

  /** Aceitar = reservar o estoque do pedido (tudo ou nada). */
  async acceptChannelOrder(id: string, orderId: string): Promise<{ data: ChannelOrderView; replayed: boolean; expiresAt: string | null }> {
    const { data } = await this.client.post(`/sales-channels/${id}/orders/${orderId}/accept`, {});
    return data;
  }

  /** Converter = o pedido vira venda (pagamento confirmado exigido). Idempotente. */
  async convertChannelOrder(id: string, orderId: string): Promise<{ data: ChannelOrderView; sale: { id: string; saleNumber: number; status: string; totalAmount: number }; replayed: boolean }> {
    const { data } = await this.client.post(`/sales-channels/${id}/orders/${orderId}/convert`, {});
    return data;
  }

  async updateChannelFulfillment(id: string, orderId: string, body: { status: string; type?: string; notes?: string }): Promise<{ data: { status: string; type: string | null } }> {
    const { data } = await this.client.patch(`/sales-channels/${id}/orders/${orderId}/fulfillment`, body);
    return data;
  }

  async getPdvDashboard(params?: { branchId?: string }) {
    const { data } = await this.client.get('/dashboard/pdv', { params });
    return data;
  }

  async getSuperAdminDashboard() {
    const { data } = await this.client.get('/dashboard/super-admin');
    return data;
  }

  async getCeoDashboard(params?: { companyId?: string; startDate?: string; endDate?: string }) {
    const { data } = await this.client.get('/dashboard/ceo', { params });
    return data;
  }

  // Revisões / Pós-venda / Agenda (domínio novo, 2026-09-14) — ao
  // contrário de /partners, estas rotas devolvem o JSON puro do service
  // (sem envelope {success, data}), ver revisions.routes.ts/follow-ups.
  // routes.ts/appointments.routes.ts.
  async getRevisions(params?: { branchId?: string; customerId?: string; motorcycleId?: string; dueBefore?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/revisions', { params });
    return data;
  }

  async createRevision(revision: {
    branchId?: string;
    customerId: string;
    motorcycleId: string;
    serviceOrderId?: string;
    performedAt: string;
    kilometerAtService: number;
    servicesPerformed: string;
    partsReplaced?: string;
    recommendations?: string;
    notes?: string;
    intervalMonths?: number;
    intervalKilometers?: number;
  }) {
    const { data } = await this.client.post('/revisions', revision);
    return data;
  }

  async getFollowUpDashboard(branchId?: string) {
    const { data } = await this.client.get('/follow-ups/dashboard', { params: branchId ? { branchId } : undefined });
    return data;
  }

  async getFollowUps(params?: { branchId?: string; status?: 'PENDING' | 'SCHEDULED' | 'CANCELLED'; customerId?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/follow-ups', { params });
    return data;
  }

  async getFollowUp(id: string) {
    const { data } = await this.client.get(`/follow-ups/${id}`);
    return data;
  }

  async createFollowUp(followUp: { branchId?: string; revisionId?: string; customerId: string; motorcycleId: string; dueDate: string; notes?: string }) {
    const { data } = await this.client.post('/follow-ups', followUp);
    return data;
  }

  async logFollowUpContact(id: string, contact: { channel: 'PHONE' | 'WHATSAPP' | 'SMS' | 'EMAIL'; message?: string }) {
    const { data } = await this.client.post(`/follow-ups/${id}/contact`, contact);
    return data;
  }

  async acceptFollowUp(id: string, reason?: string) {
    const { data } = await this.client.post(`/follow-ups/${id}/accept`, { reason });
    return data;
  }

  async declineFollowUp(id: string, reason?: string) {
    const { data } = await this.client.post(`/follow-ups/${id}/decline`, { reason });
    return data;
  }

  async cancelFollowUp(id: string, reason?: string) {
    const { data } = await this.client.post(`/follow-ups/${id}/cancel`, { reason });
    return data;
  }

  async getAppointments(params?: { branchId?: string; status?: string; customerId?: string; from?: string; to?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/appointments', { params });
    return data;
  }

  async getAppointment(id: string) {
    const { data } = await this.client.get(`/appointments/${id}`);
    return data;
  }

  async createAppointment(appointment: { branchId?: string; followUpId?: string; customerId: string; motorcycleId?: string; scheduledAt: string; notes?: string }) {
    const { data } = await this.client.post('/appointments', appointment);
    return data;
  }

  // REGRA FUNDAMENTAL do domínio (ver appointment.service.ts): esta ação só
  // deve ser usada quando um funcionário está, nesse instante, confirmando
  // que o cliente/responsável pelo veículo aceitou o horário — nunca uma
  // confirmação automática.
  async confirmAppointment(
    id: string,
    confirmation: { channel: 'PHONE' | 'WHATSAPP' | 'SMS' | 'EMAIL' | 'IN_PERSON'; confirmedByName: string; notes?: string }
  ) {
    const { data } = await this.client.post(`/appointments/${id}/confirm`, confirmation);
    return data;
  }

  async rescheduleAppointment(id: string, newScheduledAt: string, reason?: string) {
    const { data } = await this.client.post(`/appointments/${id}/reschedule`, { newScheduledAt, reason });
    return data;
  }

  async cancelAppointment(id: string, reason?: string) {
    const { data } = await this.client.post(`/appointments/${id}/cancel`, { reason });
    return data;
  }

  async completeAppointment(id: string, notes?: string) {
    const { data } = await this.client.post(`/appointments/${id}/complete`, { notes });
    return data;
  }

  async markAppointmentNoShow(id: string, notes?: string) {
    const { data } = await this.client.post(`/appointments/${id}/no-show`, { notes });
    return data;
  }

  // Oficina / Ordens de Serviço — sem envelope {success, data}, mesmo
  // padrão de revisions/follow-ups/appointments (ver service-orders.routes.ts).
  async getServiceOrders(params?: { branchId?: string; status?: string; mechanicId?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/service-orders', { params });
    return data;
  }

  async getServiceOrder(id: string) {
    const { data } = await this.client.get(`/service-orders/${id}`);
    return data;
  }

  async createServiceOrder(os: {
    branchId: string;
    customerId: string;
    motorcycleId: string;
    entryKilometer: number;
    fuelLevel?: string;
    visibleDamages?: string;
    personalItems?: string;
    entryNotes?: string;
    estimatedDelivery?: string;
  }) {
    const { data } = await this.client.post('/service-orders', os);
    return data;
  }

  async addServiceOrderItem(
    id: string,
    item: { itemType: 'SERVICE' | 'PART'; productId?: string; description: string; quantity: number; unitPrice: number }
  ) {
    const { data } = await this.client.post(`/service-orders/${id}/items`, item);
    return data;
  }

  async transitionServiceOrderStatus(id: string, toStatus: string, notes?: string) {
    const { data } = await this.client.post(`/service-orders/${id}/status`, { toStatus, notes });
    return data;
  }

  async assignServiceOrderMechanic(id: string, mechanicId: string) {
    const { data } = await this.client.post(`/service-orders/${id}/mechanic`, { mechanicId });
    return data;
  }

  async registerServiceOrderPayment(id: string, paymentMethod: string) {
    const { data } = await this.client.post(`/service-orders/${id}/payment`, { paymentMethod });
    return data;
  }

  // Estoque — sem envelope {success,data}, ver stock.routes.ts.
  async getStockReport(params?: { branchId?: string; categoryId?: string; status?: string }) {
    const { data } = await this.client.get('/stock/report', { params });
    return data;
  }

  async getStockMovements(params?: { branchId?: string; productId?: string; movementType?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/stock/movements', { params });
    return data;
  }

  async getStockBalance(productId: string, branchId?: string) {
    const { data } = await this.client.get(`/stock/balance/${productId}`, { params: branchId ? { branchId } : undefined });
    return data;
  }

  async adjustStock(adjustment: { productId: string; branchId?: string; newQuantity: number; reason: string }) {
    const { data } = await this.client.post('/stock/adjustment', adjustment);
    return data;
  }

  // Inventário físico (planejamento → contagem → fechamento) — distinto do
  // ajuste avulso acima. Ver inventory.service.ts.
  async getInventories(branchId?: string) {
    const { data } = await this.client.get('/inventory', { params: branchId ? { branchId } : undefined });
    return data.inventories;
  }

  async getInventory(id: string) {
    const { data } = await this.client.get(`/inventory/${id}`);
    return data;
  }

  async startInventory(branchId: string, notes?: string) {
    const { data } = await this.client.post('/inventory', { branchId, notes });
    return data;
  }

  async addInventoryCount(inventoryId: string, productId: string, countedQuantity: number, notes?: string) {
    const { data } = await this.client.post(`/inventory/${inventoryId}/counts`, { productId, countedQuantity, notes });
    return data;
  }

  async closeInventory(id: string) {
    const { data } = await this.client.post(`/inventory/${id}/close`);
    return data;
  }

  async cancelInventory(id: string, reason: string) {
    const { data } = await this.client.post(`/inventory/${id}/cancel`, { reason });
    return data;
  }

  // Transferências entre filiais (SOLICITADA → APROVADA → EM TRÂNSITO →
  // RECEBIDA) — distinto de stock.transfer (instantâneo, sem workflow).
  async getTransfers(params?: { branchId?: string; status?: string }) {
    const { data } = await this.client.get('/transfers', { params });
    return data.transfers;
  }

  async getTransfer(id: string) {
    const { data } = await this.client.get(`/transfers/${id}`);
    return data;
  }

  async requestTransfer(transfer: { fromBranchId: string; toBranchId: string; items: Array<{ productId: string; quantity: number }>; notes?: string }) {
    const { data } = await this.client.post('/transfers', transfer);
    return data;
  }

  async approveTransfer(id: string) {
    const { data } = await this.client.post(`/transfers/${id}/approve`);
    return data;
  }

  async rejectTransfer(id: string, reason: string) {
    const { data } = await this.client.post(`/transfers/${id}/reject`, { reason });
    return data;
  }

  async sendTransfer(id: string, items: Array<{ transferItemId: string; sentQuantity: number }>) {
    const { data } = await this.client.post(`/transfers/${id}/send`, { items });
    return data;
  }

  async receiveTransfer(id: string, items: Array<{ transferItemId: string; receivedQuantity: number }>) {
    const { data } = await this.client.post(`/transfers/${id}/receive`, { items });
    return data;
  }

  async cancelTransfer(id: string, reason: string) {
    const { data } = await this.client.post(`/transfers/${id}/cancel`, { reason });
    return data;
  }

  // Financeiro (contas a pagar/receber + fluxo de caixa) — sem envelope
  // {success,data}, ver financial.routes.ts.
  async getPayables(params?: { branchId?: string; supplierId?: string; status?: string; startDate?: string; endDate?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/financial/payables', { params });
    return data;
  }

  async createPayable(payable: { branchId?: string; supplierId?: string; description: string; amount: number; dueDate: string }) {
    const { data } = await this.client.post('/financial/payables', payable);
    return data;
  }

  async payPayable(id: string) {
    const { data } = await this.client.post(`/financial/payables/${id}/pay`);
    return data;
  }

  async cancelPayable(id: string, reason?: string) {
    const { data } = await this.client.post(`/financial/payables/${id}/cancel`, { reason });
    return data;
  }

  async reversePayable(id: string, reason: string) {
    const { data } = await this.client.post(`/financial/payables/${id}/reverse`, { reason });
    return data;
  }

  async getReceivables(params?: { branchId?: string; customerId?: string; status?: string; startDate?: string; endDate?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/financial/receivables', { params });
    return data;
  }

  async createReceivable(receivable: { branchId?: string; customerId?: string; description: string; amount: number; dueDate: string }) {
    const { data } = await this.client.post('/financial/receivables', receivable);
    return data;
  }

  async receiveReceivable(id: string) {
    const { data } = await this.client.post(`/financial/receivables/${id}/receive`);
    return data;
  }

  async cancelReceivable(id: string, reason?: string) {
    const { data } = await this.client.post(`/financial/receivables/${id}/cancel`, { reason });
    return data;
  }

  async reverseReceivable(id: string, reason: string) {
    const { data } = await this.client.post(`/financial/receivables/${id}/reverse`, { reason });
    return data;
  }

  async getCashFlowSummary(params?: { branchId?: string; startDate?: string; endDate?: string }) {
    const { data } = await this.client.get('/financial/cash-flow', { params });
    return data;
  }

  // Mecânicos/Comissões — mecanicId referencia User (sem endpoint próprio
  // de listagem, ver mechanics.routes.ts); use getUsers() para nomes.
  async getMechanicCommissions(params?: { mechanicId?: string; isPaid?: boolean; page?: number; limit?: number }) {
    const { data } = await this.client.get('/mechanics/commissions', { params });
    return data;
  }

  async getMechanicPendingSummary(mechanicId: string) {
    const { data } = await this.client.get(`/mechanics/${mechanicId}/commissions/pending-summary`);
    return data;
  }

  async payMechanicCommission(commissionId: string) {
    const { data } = await this.client.post(`/mechanics/commissions/${commissionId}/pay`);
    return data;
  }

  async getCommissionRules() {
    const { data } = await this.client.get('/commission-rules');
    return data.rules;
  }

  async createCommissionRule(rule: { name: string; serviceType?: string; percentage: number }) {
    const { data } = await this.client.post('/commission-rules', rule);
    return data;
  }

  async updateCommissionRule(id: string, rule: Partial<{ name: string; serviceType: string; percentage: number; isActive: boolean }>) {
    const { data } = await this.client.put(`/commission-rules/${id}`, rule);
    return data;
  }

  async deleteCommissionRule(id: string) {
    const { data } = await this.client.delete(`/commission-rules/${id}`);
    return data;
  }

  // Avarias — registrar já EXIGE Gerente/Admin (a permissão para chegar na
  // rota já é a aprovação, ver damage.routes.ts). Estorno é irreversível.
  async getDamageRecords(params?: { branchId?: string; productId?: string; isReversed?: boolean }) {
    const { data } = await this.client.get('/damage', { params });
    return data.damages;
  }

  async createDamageRecord(damage: {
    branchId: string;
    productId: string;
    quantity: number;
    reason: 'EXPIRED' | 'DAMAGED' | 'LOST' | 'THEFT';
    description?: string;
  }) {
    const { data } = await this.client.post('/damage', damage);
    return data;
  }

  async reverseDamageRecord(id: string, reason: string) {
    const { data } = await this.client.post(`/damage/${id}/reverse`, { reason });
    return data;
  }

  // Fiscal — SEM provedor real integrado neste ambiente (ver
  // fiscal-adapters/unconfigured-adapter.ts): emitir SEMPRE fica PENDING
  // com uma mensagem honesta, nunca finge autorização. A tela precisa
  // deixar isso claro, nunca sugerir que uma NFC-e/NFe foi de fato
  // autorizada pela SEFAZ.
  async getFiscalConfig(branchId: string) {
    const { data } = await this.client.get('/fiscal/config', { params: { branchId } });
    return data;
  }

  async upsertFiscalConfig(config: {
    branchId: string;
    nfceEnabled?: boolean;
    nfceSeriesNumber?: number;
    nfeEnabled?: boolean;
    nfeSeriesNumber?: number;
    certificatePath?: string;
    certificatePassword?: string;
    cscId?: string;
    cscToken?: string;
    environment?: string;
    cancelTimeLimit?: number;
  }) {
    const { data } = await this.client.post('/fiscal/config', config);
    return data;
  }

  async getFiscalDocuments(params?: { branchId?: string; status?: string; saleId?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/fiscal/documents', { params });
    return data;
  }

  async emitFiscalDocument(saleId: string, branchId: string) {
    const { data } = await this.client.post('/fiscal/documents', { saleId, branchId });
    return data;
  }

  async cancelFiscalDocument(id: string, reason?: string) {
    const { data } = await this.client.post(`/fiscal/documents/${id}/cancel`, { reason });
    return data;
  }

  // MFA — TOTP (app autenticador) é a única forma com provedor real neste
  // ambiente; SMS/e-mail só funcionam fora de produção (sem Twilio/SES
  // configurado, ver MFAService.ts) e por isso não têm UI própria aqui.
  async setupMfa() {
    const { data } = await this.client.post('/mfa/setup');
    return data;
  }

  async verifyMfa(code: string) {
    const { data } = await this.client.post('/mfa/verify', { code });
    return data;
  }

  async disableMfa(password: string) {
    const { data } = await this.client.post('/mfa/disable', { password });
    return data;
  }

  // Ativação/desativação de módulos por empresa/filial — o backend
  // (requireModuleEnabled, apps/api/src/middleware/module.ts) já é a
  // autoridade real; esta tela só reflete/aciona o que ele decide.
  async getPaymentSettings(branchId?: string): Promise<{ cashDenominationControl: boolean; source: 'branch' | 'company' | 'default' }> {
    const { data } = await this.client.get('/payment-settings', { params: branchId ? { branchId } : undefined });
    return data;
  }

  async setPaymentSettings(body: { branchId?: string | null; cashDenominationControl: boolean | null }) {
    const { data } = await this.client.put('/payment-settings', body);
    return data;
  }

  async getModuleSettings(branchId?: string) {
    const { data } = await this.client.get('/module-settings', { params: branchId ? { branchId } : undefined });
    return data;
  }

  // Orçamentos (apps/api quotes.routes.ts) — módulo OFICINA. Leitura aberta
  // ao tenant; escrita bloqueada só para VIEWER (a API é a autoridade).
  async getQuotes(params?: { status?: string; customerId?: string; branchId?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/quotes', { params });
    return data;
  }

  async getQuote(id: string) {
    const { data } = await this.client.get(`/quotes/${id}`);
    return data;
  }

  async createQuote(quote: {
    branchId: string;
    customerId: string;
    motorcycleId: string;
    validUntil?: string;
    notes?: string;
    items: QuoteItemPayload[];
  }) {
    const { data } = await this.client.post('/quotes', quote);
    return data;
  }

  async addQuoteVersion(id: string, payload: { items: QuoteItemPayload[] }) {
    const { data } = await this.client.post(`/quotes/${id}/versions`, payload);
    return data;
  }

  async sendQuote(id: string, versionNumber: number) {
    const { data } = await this.client.post(`/quotes/${id}/send`, { versionNumber });
    return data;
  }

  async decideQuote(id: string, payload: { versionNumber: number; approved: boolean; decisionNotes?: string }) {
    const { data } = await this.client.post(`/quotes/${id}/decide`, payload);
    return data;
  }

  async convertQuoteToServiceOrder(
    id: string,
    payload: {
      branchId: string;
      entryKilometer: number;
      fuelLevel?: string;
      visibleDamages?: string;
      personalItems?: string;
      entryNotes?: string;
    }
  ) {
    const { data } = await this.client.post(`/quotes/${id}/convert`, payload);
    return data;
  }

  async getModuleSettingsHistory() {
    const { data } = await this.client.get('/module-settings/history');
    return data;
  }

  async setModuleEnabled(module: string, payload: { isEnabled: boolean; branchId?: string | null; reason?: string }) {
    const { data } = await this.client.post(`/module-settings/${module}`, payload);
    return data;
  }

  // Permissões efetivas do PRÓPRIO usuário logado (o backend restringe este
  // endpoint a self-ou-admin — ver user.routes.ts) — usado pela Sidebar
  // para refletir o que o backend realmente concederia, nunca para decidir
  // autorização por conta própria no cliente.
  async getMyPermissions(userId: string) {
    const { data } = await this.client.get(`/users/${userId}/permissions`);
    return data;
  }

  // Avarias com paginação: getDamageRecords() devolve só `data.damages` e
  // descarta `pagination`, então a tela nunca soube que havia mais registros
  // além da primeira página. Este devolve a resposta inteira
  // ({ damages, pagination: { page, limit, total, pages } }).
  async getDamageRecordsPage(params?: {
    branchId?: string;
    productId?: string;
    isReversed?: boolean;
    page?: number;
    limit?: number;
  }) {
    const { data } = await this.client.get('/damage', { params });
    return data;
  }
}

export const api = new ApiClient();

// Usuário atual, lido a partir do JWT já armazenado em localStorage pelo
// login (token de acesso, não verificado aqui — a validação real acontece
// no backend; isto serve só para decidir o que renderizar na UI). Não há
// endpoint GET /auth/me no backend hoje, então este é o único jeito de saber
// o userType/companyId/branchId do usuário logado sem re-autenticar.
export interface CurrentUserClaims {
  userId: string;
  email: string;
  companyId?: string;
  branchId?: string;
  userType: 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'MANAGER' | 'OPERATOR' | 'MECHANIC' | 'VIEWER';
}

export function getCurrentUserClaims(): CurrentUserClaims | null {
  if (typeof window === 'undefined') return null;
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}
