import { redis } from '../config/redis';

/**
 * Cache TTL Constants (em segundos)
 */
export const CacheTTL = {
  // Dados que mudam frequentemente
  DASHBOARD_STATS: 2 * 60,        // 2 minutos
  CASH_REGISTER: 1 * 60,          // 1 minuto
  CURRENT_STOCK: 3 * 60,          // 3 minutos
  
  // Dados que mudam moderadamente
  PRODUCTS_LIST: 5 * 60,          // 5 minutos
  CUSTOMERS_LIST: 5 * 60,         // 5 minutos
  SALES_LIST: 5 * 60,             // 5 minutos
  
  // Dados que mudam pouco
  USER_PROFILE: 10 * 60,          // 10 minutos
  USER_PERMISSIONS: 10 * 60,      // 10 minutos
  PRODUCT_DETAILS: 10 * 60,       // 10 minutos
  CUSTOMER_DETAILS: 10 * 60,      // 10 minutos
  
  // Dados que mudam raramente
  COMPANY_SETTINGS: 15 * 60,      // 15 minutos
  BRANCH_SETTINGS: 15 * 60,       // 15 minutos
  CATEGORIES: 15 * 60,            // 15 minutos
  ROLES_PERMISSIONS: 15 * 60,     // 15 minutos
  // Mais curto que os demais "raramente mudam" de propósito: isto é um
  // GATE de acesso (requireModuleEnabled), não só uma lista pra exibir —
  // sempre invalidado no toggle (module-settings.service.ts), o TTL é só
  // rede de segurança para uma invalidação que eventualmente falhe.
  MODULE_SETTINGS: 5 * 60,        // 5 minutos
  
  // Dados muito estáveis
  LICENSE_INFO: 30 * 60,          // 30 minutos
  
  // Default
  DEFAULT: 60 * 60,               // 1 hora
} as const;

/**
 * Serviço de cache usando Redis
 * Facilita o armazenamento e recuperação de dados em cache
 */
export class CacheService {
  /**
   * Obter valor do cache
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await redis.get(key);
      
      if (!data) {
        return null;
      }

      return JSON.parse(data) as T;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  /**
   * Armazenar valor no cache
   * @param key - Chave do cache
   * @param value - Valor a ser armazenado
   * @param ttl - Tempo de vida em segundos (padrão: usa CacheTTL.DEFAULT)
   */
  async set(key: string, value: any, ttl: number = CacheTTL.DEFAULT): Promise<void> {
    try {
      await redis.setex(key, ttl, JSON.stringify(value));
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  /**
   * Deletar valor do cache
   */
  async delete(key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }

  /**
   * Deletar múltiplas chaves por padrão
   * @param pattern - Padrão de busca (ex: "user:*", "product:123:*")
   */
  async invalidate(pattern: string): Promise<void> {
    try {
      const keys = await redis.keys(pattern);
      
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      console.error('Cache invalidate error:', error);
    }
  }

  /**
   * Verificar se chave existe
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await redis.exists(key);
      return result === 1;
    } catch (error) {
      console.error('Cache exists error:', error);
      return false;
    }
  }

  /**
   * Definir tempo de expiração para uma chave existente
   */
  async expire(key: string, ttl: number): Promise<void> {
    try {
      await redis.expire(key, ttl);
    } catch (error) {
      console.error('Cache expire error:', error);
    }
  }

  /**
   * Incrementar valor numérico
   */
  async increment(key: string, amount: number = 1): Promise<number> {
    try {
      return await redis.incrby(key, amount);
    } catch (error) {
      console.error('Cache increment error:', error);
      return 0;
    }
  }

  /**
   * Decrementar valor numérico
   */
  async decrement(key: string, amount: number = 1): Promise<number> {
    try {
      return await redis.decrby(key, amount);
    } catch (error) {
      console.error('Cache decrement error:', error);
      return 0;
    }
  }

  /**
   * Armazenar em hash
   */
  async hset(key: string, field: string, value: any): Promise<void> {
    try {
      await redis.hset(key, field, JSON.stringify(value));
    } catch (error) {
      console.error('Cache hset error:', error);
    }
  }

  /**
   * Obter de hash
   */
  async hget<T>(key: string, field: string): Promise<T | null> {
    try {
      const data = await redis.hget(key, field);
      
      if (!data) {
        return null;
      }

      return JSON.parse(data) as T;
    } catch (error) {
      console.error('Cache hget error:', error);
      return null;
    }
  }

  /**
   * Obter todos os campos de um hash
   */
  async hgetall<T>(key: string): Promise<Record<string, T>> {
    try {
      const data = await redis.hgetall(key);
      
      const result: Record<string, T> = {};
      
      for (const [field, value] of Object.entries(data)) {
        result[field] = JSON.parse(value) as T;
      }

      return result;
    } catch (error) {
      console.error('Cache hgetall error:', error);
      return {};
    }
  }

  /**
   * Deletar campo de hash
   */
  async hdel(key: string, ...fields: string[]): Promise<void> {
    try {
      await redis.hdel(key, ...fields);
    } catch (error) {
      console.error('Cache hdel error:', error);
    }
  }

  /**
   * Adicionar item a uma lista
   */
  async lpush(key: string, ...values: any[]): Promise<void> {
    try {
      const serialized = values.map(v => JSON.stringify(v));
      await redis.lpush(key, ...serialized);
    } catch (error) {
      console.error('Cache lpush error:', error);
    }
  }

  /**
   * Obter range de uma lista
   */
  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    try {
      const data = await redis.lrange(key, start, stop);
      return data.map(item => JSON.parse(item) as T);
    } catch (error) {
      console.error('Cache lrange error:', error);
      return [];
    }
  }

  /**
   * Wrapper para buscar ou calcular valor
   * Se existe no cache, retorna. Senão, executa função e cacheia resultado.
   */
  async remember<T>(
    key: string,
    ttl: number,
    callback: () => Promise<T>
  ): Promise<T> {
    // Tentar obter do cache
    const cached = await this.get<T>(key);
    
    if (cached !== null) {
      return cached;
    }

    // Se não existe, executar callback
    const result = await callback();

    // Cachear resultado
    await this.set(key, result, ttl);

    return result;
  }

  /**
   * Lock distribuído (para evitar race conditions)
   */
  async lock(key: string, ttl: number = 10): Promise<boolean> {
    try {
      const result = await redis.set(key, '1', 'EX', ttl, 'NX');
      return result === 'OK';
    } catch (error) {
      console.error('Cache lock error:', error);
      return false;
    }
  }

  /**
   * Liberar lock
   */
  async unlock(key: string): Promise<void> {
    await this.delete(key);
  }
}

// Exportar instância singleton
export default new CacheService();

/**
 * Helpers para gerar chaves de cache padronizadas
 */
export const CacheKeys = {
  // User
  user: (id: string) => `user:${id}`,
  userPermissions: (id: string) => `user:${id}:permissions`,
  
  // Product
  product: (id: string) => `product:${id}`,
  products: (companyId: string, page: number) => `products:${companyId}:page:${page}`,
  productStock: (id: string, branchId?: string) => 
    `product:${id}:stock${branchId ? `:${branchId}` : ''}`,
  
  // Sale
  sale: (id: string) => `sale:${id}`,
  sales: (companyId: string, page: number) => `sales:${companyId}:page:${page}`,
  salesStats: (companyId: string, branchId?: string) => 
    `sales:stats:${companyId}${branchId ? `:${branchId}` : ''}`,
  
  // Customer
  customer: (id: string) => `customer:${id}`,
  customers: (companyId: string, page: number) => `customers:${companyId}:page:${page}`,
  
  // Company
  company: (id: string) => `company:${id}`,
  companies: (page: number) => `companies:page:${page}`,
  
  // Cash Register
  cashRegister: (id: string) => `cash-register:${id}`,
  currentCashRegister: (branchId: string) => `cash-register:current:${branchId}`,
  
  // License
  license: (id: string) => `license:${id}`,
  
  // Lock keys
  lock: (resource: string, id: string) => `lock:${resource}:${id}`,

  // Module settings (feature flags por empresa/filial)
  moduleSettings: (companyId: string) => `company:${companyId}:module-settings`,
  // Contador de "geração" do estado acima: cada alteração o incrementa e uma
  // entrada de cache só vale se a geração gravada nela for a atual (ver
  // ModuleSettingsService.getCompanySettings — fecha a corrida leitura-antiga x invalidação).
  moduleSettingsGen: (companyId: string) => `company:${companyId}:module-settings:gen`,
};
