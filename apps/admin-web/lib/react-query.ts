import { QueryClient } from '@tanstack/react-query';

/**
 * Configuração do React Query para otimização de performance
 * 
 * - staleTime: Tempo que os dados são considerados "frescos" (não refetch automático)
 * - cacheTime: Tempo que os dados ficam em cache após serem "inativos"
 * - refetchOnWindowFocus: Desabilitado para evitar requisições desnecessárias
 * - retry: Apenas 1 tentativa de retry para falhas de rede
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Dados considerados frescos por 5 minutos
      staleTime: 5 * 60 * 1000,
      
      // Manter em cache por 10 minutos
      gcTime: 10 * 60 * 1000, // gcTime é o novo nome do cacheTime no v5
      
      // Não refetch ao voltar para a janela
      refetchOnWindowFocus: false,
      
      // Não refetch ao reconectar
      refetchOnReconnect: false,
      
      // Retry apenas 1 vez
      retry: 1,
      
      // Tempo de retry: 1 segundo
      retryDelay: 1000,
    },
    mutations: {
      // Retry mutations apenas 1 vez
      retry: 1,
    },
  },
});

/**
 * Query Keys padronizadas para facilitar invalidação de cache
 */
export const queryKeys = {
  // Dashboard
  dashboardStats: (companyId: string, branchId?: string) => 
    ['dashboard', 'stats', companyId, branchId].filter(Boolean),
  
  // Products
  products: (companyId: string, filters?: Record<string, any>) => 
    ['products', companyId, filters].filter(Boolean),
  product: (id: string) => ['product', id],
  productStock: (id: string, branchId?: string) => 
    ['product', id, 'stock', branchId].filter(Boolean),
  
  // Customers
  customers: (companyId: string, filters?: Record<string, any>) => 
    ['customers', companyId, filters].filter(Boolean),
  customer: (id: string) => ['customer', id],
  
  // Sales
  sales: (companyId: string, filters?: Record<string, any>) => 
    ['sales', companyId, filters].filter(Boolean),
  sale: (id: string) => ['sale', id],
  
  // Users
  users: (companyId: string) => ['users', companyId],
  user: (id: string) => ['user', id],
  userProfile: () => ['user', 'profile'],
  
  // Company
  company: (id: string) => ['company', id],
  companySettings: (id: string) => ['company', id, 'settings'],
  
  // Cash Register
  cashRegisters: (branchId: string) => ['cash-registers', branchId],
  cashRegister: (id: string) => ['cash-register', id],
  currentCashRegister: (branchId: string) => ['cash-register', 'current', branchId],
  
  // Categories
  categories: (companyId: string) => ['categories', companyId],
  
  // Reports
  report: (type: string, params: Record<string, any>) => ['report', type, params],
} as const;
