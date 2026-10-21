/**
 * Offline Service - Sistema de sincronização para modo offline
 * Usa IndexedDB para armazenar dados localmente
 */

import Dexie, { Table } from 'dexie';

// Tipos
interface PendingSync {
  id?: number;
  type: 'sale' | 'payment' | 'customer' | 'stock' | 'cash_movement';
  action: 'create' | 'update' | 'delete';
  data: any;
  timestamp: number;
  retries: number;
  lastError?: string;
  // 0/1 em vez de boolean: IndexedDB/Dexie não suportam boolean como valor
  // de índice de forma confiável entre navegadores — os 4 índices por
  // `synced` (.where('synced').equals(...)) exigem um IndexableType real
  // (string/number/Date/...), então isto não é só uma questão de tipagem.
  synced: 0 | 1;
}

interface CachedData {
  id?: number;
  type: 'products' | 'customers' | 'categories' | 'users';
  key: string;
  data: any;
  timestamp: number;
  expiresAt: number;
}

// Database
class OfflineDatabase extends Dexie {
  pendingSync!: Table<PendingSync, number>;
  cachedData!: Table<CachedData, number>;

  constructor() {
    super('PDVOffline');

    this.version(1).stores({
      pendingSync: '++id, type, synced, timestamp',
      cachedData: '++id, type, key, expiresAt',
    });
  }
}

const db = new OfflineDatabase();

class OfflineService {
  private isOnline: boolean = navigator.onLine;
  private syncInterval: NodeJS.Timeout | null = null;
  private listeners: Array<(isOnline: boolean) => void> = [];

  constructor() {
    this.setupOnlineListeners();
    this.startSyncInterval();
  }

  /**
   * Configurar listeners de conectividade
   */
  private setupOnlineListeners() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.notifyListeners(true);
      this.syncPendingOperations();
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.notifyListeners(false);
    });
  }

  /**
   * Iniciar sincronização periódica
   */
  private startSyncInterval() {
    // Tentar sincronizar a cada 30 segundos
    this.syncInterval = setInterval(() => {
      if (this.isOnline) {
        this.syncPendingOperations();
      }
    }, 30000);
  }

  /**
   * Parar sincronização periódica
   */
  stopSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /**
   * Adicionar listener de status de conexão
   */
  onConnectionChange(callback: (isOnline: boolean) => void) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }

  /**
   * Notificar listeners sobre mudança de status
   */
  private notifyListeners(isOnline: boolean) {
    this.listeners.forEach(callback => callback(isOnline));
  }

  /**
   * Verificar se está online
   */
  getOnlineStatus(): boolean {
    return this.isOnline;
  }

  /**
   * Adicionar operação pendente
   */
  async addPendingOperation(
    type: PendingSync['type'],
    action: PendingSync['action'],
    data: any
  ): Promise<number> {
    const operation: PendingSync = {
      type,
      action,
      data,
      timestamp: Date.now(),
      retries: 0,
      synced: 0,
    };

    const id = await db.pendingSync.add(operation);

    // Tentar sincronizar imediatamente se online
    if (this.isOnline) {
      setTimeout(() => this.syncPendingOperations(), 1000);
    }

    return id;
  }

  /**
   * Sincronizar operações pendentes
   */
  async syncPendingOperations(): Promise<{ success: number; failed: number }> {
    const pending = await db.pendingSync
      .where('synced')
      .equals(0)
      .and(op => op.retries < 3)
      .toArray();

    if (pending.length === 0) {
      return { success: 0, failed: 0 };
    }


    let success = 0;
    let failed = 0;

    for (const operation of pending) {
      try {
        await this.syncOperation(operation);
        
        // Marcar como sincronizado
        await db.pendingSync.update(operation.id!, {
          synced: 1,
        });

        success++;
      } catch (error: any) {
        failed++;
        console.error(`❌ Erro ao sincronizar operação ${operation.id}:`, error);

        // Atualizar contagem de retries e erro
        await db.pendingSync.update(operation.id!, {
          retries: operation.retries + 1,
          lastError: error.message,
        });

        // Se atingiu o limite de retries, marcar como falha permanente
        if (operation.retries >= 2) {
          console.error(`⚠️ Operação ${operation.id} falhou após 3 tentativas`);
        }
      }
    }


    return { success, failed };
  }

  /**
   * Sincronizar uma operação específica
   */
  private async syncOperation(operation: PendingSync): Promise<void> {
    const apiUrl = localStorage.getItem('apiUrl') || 'http://localhost:3001';
    const token = localStorage.getItem('token');

    if (!token) {
      throw new Error('Token não encontrado');
    }

    const endpoint = this.getEndpointForOperation(operation);
    const method = operation.action === 'create' ? 'POST' : operation.action === 'update' ? 'PUT' : 'DELETE';

    const response = await fetch(`${apiUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(operation.data),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Erro na sincronização');
    }

    return await response.json();
  }

  /**
   * Obter endpoint da API para a operação
   */
  private getEndpointForOperation(operation: PendingSync): string {
    const { type, action, data } = operation;

    switch (type) {
      case 'sale':
        return action === 'create' ? '/api/sales' : `/api/sales/${data.id}`;
      case 'payment':
        return action === 'create' ? '/api/payments' : `/api/payments/${data.id}`;
      case 'customer':
        return action === 'create' ? '/api/customers' : `/api/customers/${data.id}`;
      case 'stock':
        return `/api/stock/${data.id}`;
      case 'cash_movement':
        return action === 'create' ? '/api/cash-register/movement' : `/api/cash-register/movement/${data.id}`;
      default:
        throw new Error(`Tipo de operação desconhecido: ${type}`);
    }
  }

  /**
   * Cachear dados
   */
  async cacheData(type: CachedData['type'], key: string, data: any, ttlMinutes: number = 60): Promise<void> {
    const now = Date.now();
    const expiresAt = now + (ttlMinutes * 60 * 1000);

    await db.cachedData.put({
      type,
      key,
      data,
      timestamp: now,
      expiresAt,
    });

  }

  /**
   * Obter dados do cache
   */
  async getCachedData(type: CachedData['type'], key: string): Promise<any | null> {
    const cached = await db.cachedData
      .where({ type, key })
      .first();

    if (!cached) {
      return null;
    }

    // Verificar se expirou
    if (Date.now() > cached.expiresAt) {
      await db.cachedData.delete(cached.id!);
      return null;
    }

    return cached.data;
  }

  /**
   * Limpar cache expirado
   */
  async clearExpiredCache(): Promise<number> {
    const now = Date.now();
    const expired = await db.cachedData
      .where('expiresAt')
      .below(now)
      .count();

    await db.cachedData
      .where('expiresAt')
      .below(now)
      .delete();


    return expired;
  }

  /**
   * Obter estatísticas de sincronização
   */
  async getSyncStats(): Promise<{
    pending: number;
    synced: number;
    failed: number;
    cachedItems: number;
  }> {
    const [pending, synced, failed, cachedItems] = await Promise.all([
      db.pendingSync.where('synced').equals(0).and(op => op.retries < 3).count(),
      db.pendingSync.where('synced').equals(1).count(),
      db.pendingSync.where('synced').equals(0).and(op => op.retries >= 3).count(),
      db.cachedData.count(),
    ]);

    return { pending, synced, failed, cachedItems };
  }

  /**
   * Limpar operações sincronizadas antigas (> 7 dias)
   */
  async cleanupOldSyncedOperations(): Promise<number> {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    const deleted = await db.pendingSync
      .where('synced')
      .equals(1)
      .and(op => op.timestamp < sevenDaysAgo)
      .delete();


    return deleted;
  }

  /**
   * Obter operações com falha
   */
  async getFailedOperations(): Promise<PendingSync[]> {
    return await db.pendingSync
      .where('synced')
      .equals(0)
      .and(op => op.retries >= 3)
      .toArray();
  }

  /**
   * Retentar operação específica
   */
  async retryOperation(id: number): Promise<boolean> {
    const operation = await db.pendingSync.get(id);
    
    if (!operation) {
      return false;
    }

    // Resetar contagem de retries
    await db.pendingSync.update(id, {
      retries: 0,
      lastError: undefined,
    });

    // Tentar sincronizar
    if (this.isOnline) {
      await this.syncPendingOperations();
    }

    return true;
  }

  /**
   * Deletar operação com falha permanente
   */
  async deleteFailedOperation(id: number): Promise<boolean> {
    await db.pendingSync.delete(id);
    return true;
  }
}

export const offlineService = new OfflineService();
export { db as offlineDb };
