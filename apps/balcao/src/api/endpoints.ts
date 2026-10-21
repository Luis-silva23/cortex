import { http } from './http';
import { useAuthStore } from '../store/auth.store';
import type {
  Availability,
  AuthUser,
  Branch,
  Customer,
  CustomerStats,
  LoginResult,
  Motorcycle,
  Pagination,
  Product,
  Quote,
  QuoteItemPayload,
  QuoteVersion,
  Sale,
  ServiceOrder,
} from './types';

/** Funções finas sobre as rotas oficiais. Nenhuma regra: validação, total, estado e permissão são do servidor. */

// ---- autenticação (mesmo fluxo do PDV/Admin: e-mail ou ID numérico + senha, MFA quando houver) ----
export async function login(identifier: string, password: string): Promise<LoginResult> {
  const id = identifier.trim();
  const body = id.includes('@') ? { email: id, password } : { numericId: Number(id), password };
  const { data } = await http.post('/auth/login', body);
  if (data.mfaRequired) return { kind: 'mfa', mfaToken: data.mfaToken };
  return { kind: 'ok', user: data.user as AuthUser, accessToken: data.accessToken, refreshToken: data.refreshToken };
}

export async function verifyMfa(mfaToken: string, code: string, method: 'totp' | 'backup' = 'totp'): Promise<LoginResult> {
  const { data } = await http.post('/auth/verify-mfa', { mfaToken, code, method });
  return { kind: 'ok', user: data.user as AuthUser, accessToken: data.accessToken, refreshToken: data.refreshToken };
}

export async function logout(): Promise<void> {
  const { refreshToken } = useAuthStore.getState();
  try {
    if (refreshToken) await http.post('/auth/logout', { refreshToken });
  } catch {
    // sair localmente mesmo se o servidor não responder
  }
}

// ---- cliente e veículo ----
export async function searchCustomers(search: string, limit = 10): Promise<Customer[]> {
  const { data } = await http.get('/customers/search', { params: { search, limit } });
  return data.customers ?? [];
}

export async function getCustomer(id: string): Promise<Customer & { sales?: Sale[] }> {
  return (await http.get(`/customers/${id}`)).data;
}

export async function getCustomerStats(id: string): Promise<CustomerStats> {
  return (await http.get(`/customers/${id}/stats`)).data;
}

export async function createCustomer(input: { name: string; phone?: string; document?: string }): Promise<Customer> {
  const { data } = await http.post('/customers', { ...input, customerType: 'INDIVIDUAL' });
  return data;
}

export async function listMotorcycles(params: { customerId?: string; search?: string; limit?: number }): Promise<Motorcycle[]> {
  const { data } = await http.get('/motorcycles', { params });
  return data.motorcycles ?? [];
}

export async function getMotorcycle(id: string): Promise<Motorcycle & { customer?: Customer }> {
  return (await http.get(`/motorcycles/${id}`)).data;
}

export async function createMotorcycle(input: { customerId: string; brand: string; model: string; licensePlate?: string; year?: number; kilometerReading: number }): Promise<Motorcycle> {
  const { data } = await http.post('/motorcycles', input);
  return data;
}

// ---- produto e estoque ----
export async function searchProducts(search: string, limit = 20): Promise<{ products: Product[]; pagination: Pagination }> {
  const { data } = await http.get('/products', { params: { search, isActive: true, limit } });
  return { products: data.products ?? [], pagination: data.pagination };
}

/** Disponível para venda = saldo − reservas, calculado pelo servidor (`/stock/availability`). */
export async function getAvailability(productIds: string[], branchId?: string | null): Promise<Availability[]> {
  if (productIds.length === 0) return [];
  const params: Record<string, string> = { productIds: productIds.join(',') };
  if (branchId) params.branchId = branchId;
  const { data } = await http.get('/stock/availability', { params });
  return data.items ?? [];
}

// ---- orçamento ----
export async function listQuotes(params: { customerId?: string; status?: string; page?: number; limit?: number }): Promise<{ quotes: Quote[]; pagination: Pagination }> {
  const { data } = await http.get('/quotes', { params });
  return { quotes: data.quotes ?? [], pagination: data.pagination };
}

export async function getQuote(id: string): Promise<Quote> {
  return (await http.get(`/quotes/${id}`)).data;
}

export async function createQuote(input: {
  branchId: string;
  customerId: string;
  motorcycleId: string;
  notes?: string;
  items: QuoteItemPayload[];
  confirmNew?: boolean;
}): Promise<Quote> {
  return (await http.post('/quotes', input)).data;
}

export async function addQuoteVersion(id: string, items: QuoteItemPayload[]): Promise<QuoteVersion> {
  return (await http.post(`/quotes/${id}/versions`, { items })).data;
}

export async function sendQuote(id: string, versionNumber: number): Promise<QuoteVersion> {
  return (await http.post(`/quotes/${id}/send`, { versionNumber })).data;
}

export async function decideQuote(id: string, versionNumber: number, approved: boolean, decisionNotes?: string): Promise<QuoteVersion> {
  return (await http.post(`/quotes/${id}/decide`, { versionNumber, approved, decisionNotes })).data;
}

export async function convertQuote(id: string, input: { branchId: string; entryKilometer: number }): Promise<ServiceOrder> {
  return (await http.post(`/quotes/${id}/convert`, input)).data;
}

// ---- ordem de serviço e vendas (histórico) ----
export async function listServiceOrders(params: { customerId?: string; motorcycleId?: string; status?: string; page?: number; limit?: number }): Promise<{ orders: ServiceOrder[]; pagination: Pagination }> {
  const { data } = await http.get('/service-orders', { params });
  return { orders: data.orders ?? [], pagination: data.pagination };
}

export async function getServiceOrder(id: string): Promise<ServiceOrder> {
  return (await http.get(`/service-orders/${id}`)).data;
}

export async function listSales(params: { customerId: string; limit?: number }): Promise<Sale[]> {
  const { data } = await http.get('/sales', { params });
  return data.sales ?? [];
}

export async function listBranches(): Promise<Branch[]> {
  const { data } = await http.get('/branches');
  return (data.data ?? data.branches ?? []) as Branch[];
}
