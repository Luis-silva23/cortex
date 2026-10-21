import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { resolveBackupMode } from './backup-mode';
import { DelegatedBackupService, type BackupListItem } from './DelegatedBackupService';

const execAsync = promisify(exec);

interface BackupConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  backupDir: string;
  /** Diretório do pg_dump/pg_restore, quando não estão no PATH do processo (comum em Windows). */
  pgBinDir?: string;
}

/**
 * Deriva host/porta/banco/usuário/senha de `DATABASE_URL` (a mesma variável
 * que o Prisma usa) quando as variáveis DATABASE_HOST/PORT/NAME/USER/
 * PASSWORD individuais não estão definidas. ANTES desta correção, o
 * singleton abaixo caía direto nos defaults hardcoded
 * (`postgres`/`postgres`/`lnsystem`) sempre que só DATABASE_URL existisse no
 * .env — que é exatamente o caso real deste projeto (ver apps/api/.env: só
 * DATABASE_URL é definida). Resultado: todo backup real falhava com
 * credenciais erradas, silenciosamente incompatível com o banco real
 * (lnsystem/lnsystem_db), nunca detectado porque nada testava um backup de
 * verdade até agora (confirmado em teste real: `pg_dump -U postgres -d
 * lnsystem` — usuário e banco errados).
 */
function parseDatabaseUrl(): Partial<Pick<BackupConfig, 'host' | 'port' | 'database' | 'username' | 'password'>> {
  // BACKUP_DATABASE_URL = role DEDICADO de backup (BYPASSRLS + pg_read_all_data; ver pgEnv): com FORCE RLS, o role de
  // runtime não consegue fazer pg_dump. Sem ela, cai no DATABASE_URL (comportamento anterior).
  const url = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) return {};
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || undefined,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : undefined,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
  } catch {
    logger.warn('DATABASE_URL presente mas inválida para parsing de backup — usando defaults/env individuais');
    return {};
  }
}

/** O que as rotas e o agendador usam — igual no modo local (pg_dump na própria API, só desenvolvimento) e no delegado (serviço dedicado; decisão 152). */
export interface BackupFacade {
  readonly mode: 'local' | 'delegated';
  createBackup(requestedBy?: string): Promise<{ success: boolean; requested?: boolean; requestId?: string; filePath?: string; error?: string }>;
  listBackups(): Promise<BackupListItem[]>;
  restoreBackup(backupFilePath: string): Promise<{ success: boolean; error?: string }>;
  deleteBackup(filename: string): Promise<{ success: boolean; error?: string }>;
  getBackupStats(): Promise<{ totalBackups: number; totalSize: number; oldestBackup?: Date; newestBackup?: Date }>;
}

export class BackupService implements BackupFacade {
  readonly mode = 'local' as const;
  private config: BackupConfig;

  constructor(config: BackupConfig) {
    this.config = config;
  }

  /**
   * Resolve o caminho de `pg_dump`/`pg_restore`. Em produção (containers
   * Linux com cliente Postgres instalado no PATH) `pgBinDir` fica vazio e
   * isto vira só o nome do binário — comportamento inalterado. Em Windows
   * (dev local), o instalador do PostgreSQL normalmente NÃO adiciona
   * `bin/` ao PATH do sistema (confirmado neste ambiente: `pg_dump` não
   * reconhecido mesmo com o Postgres real rodando), então `PG_BIN_DIR`
   * aponta explicitamente para ele via env.
   */
  private pgBin(binary: 'pg_dump' | 'pg_restore'): string {
    if (!this.config.pgBinDir) return binary;
    const resolved = path.join(this.config.pgBinDir, process.platform === 'win32' ? `${binary}.exe` : binary);
    return `"${resolved}"`;
  }

  /**
   * Env para o processo `pg_dump`/`pg_restore`.
   *
   * BLOQUEIO EXTERNO CONHECIDO (documentado, não escondido): toda tabela de
   * negócio usa `FORCE ROW LEVEL SECURITY` (ativo até para o dono da
   * tabela, ver migration 20260907200750) — de propósito, para que mesmo
   * uma conexão com o role dono nunca vaze dado cross-tenant por engano.
   * Isso significa que `pg_dump` rodando como `lnsystem` (o role de runtime
   * da aplicação, não superuser) falha em QUALQUER tabela com policy,
   * mesmo sendo o dono (confirmado em teste real: "query would be affected
   * by row-level security policy for table accounts_payable").
   *
   * `PGOPTIONS` abaixo tenta setar os mesmos GUCs de bypass usados pelo
   * resto da aplicação (`app.user_type=SUPER_ADMIN`) — CONFIRMADO QUE
   * FUNCIONA para uma conexão `psql` comum, mas NÃO funciona para
   * `pg_dump` (testado e reproduzido: mesmo erro de RLS mesmo com
   * PGOPTIONS setado). Mantido mesmo assim por ser inofensivo e correto
   * caso o role de backup configurado em produção não tenha BYPASSRLS mas
   * de alguma forma dependa desses GUCs por outro caminho — mas NÃO É a
   * solução real.
   *
   * A solução real (não implementável nesta sessão — falta credencial de
   * superuser do Postgres local, que nunca foi provisionada como parte
   * deste projeto) é um role DEDICADO de backup com `BYPASSRLS`, distinto
   * do `lnsystem` de runtime (nunca conceder BYPASSRLS ao próprio
   * `lnsystem` — isso desligaria a proteção de RLS para TODA query da
   * aplicação, não só o backup, exatamente o regressão de segurança que
   * `FORCE ROW LEVEL SECURITY` existe para prevenir). Em produção:
   *   CREATE ROLE lnsystem_backup LOGIN PASSWORD '...' BYPASSRLS;
   *   GRANT pg_read_all_data TO lnsystem_backup; -- ou GRANT SELECT explícito por tabela
   * e configurar DATABASE_USER/DATABASE_PASSWORD (ou uma DATABASE_URL de
   * backup separada) apontando para esse role.
   */
  private pgEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PGPASSWORD: this.config.password,
      PGOPTIONS: "-c app.user_type=SUPER_ADMIN -c app.current_company_id= -c app.current_branch_id=",
    };
  }

  /**
   * Create a database backup
   */
  async createBackup(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      logger.info('Starting database backup...');

      // Create backup directory if it doesn't exist
      await fs.mkdir(this.config.backupDir, { recursive: true });

      // Generate backup filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `backup_${this.config.database}_${timestamp}.sql`;
      const filePath = path.join(this.config.backupDir, filename);

      // PostgreSQL backup command
      const command = `${this.pgBin('pg_dump')} -h ${this.config.host} -p ${this.config.port} -U ${this.config.username} -d ${this.config.database} -F c --exclude-schema=app_ctx_vault -f "${filePath}"`;
      // `--exclude-schema=app_ctx_vault`: o segredo que assina o contexto de RLS (decisão 151) NUNCA entra no backup; depois de restaurar o DBA provisiona de novo

      // Execute backup
      await execAsync(command, { env: this.pgEnv() });

      // Verify backup file exists and has content
      const stats = await fs.stat(filePath);
      if (stats.size === 0) {
        throw new Error('Backup file is empty');
      }

      logger.info(`Backup created successfully: ${filePath} (${stats.size} bytes)`);

      // Clean old backups (keep last 30 days)
      await this.cleanOldBackups(30);

      return { success: true, filePath };
    } catch (error) {
      logger.error('Backup failed:', error);
      const rawMessage = error instanceof Error ? error.message : 'Unknown error';
      // Ver comentário em pgEnv() — causa raiz real e ação corretiva, em vez
      // de expor só o stderr cru do pg_dump para quem estiver lendo o erro.
      const message = rawMessage.includes('row-level security policy')
        ? `${rawMessage}\n\nCausa: DATABASE_USER (ou o usuário derivado de DATABASE_URL) não tem BYPASSRLS. Configure um role de backup dedicado com BYPASSRLS — ver comentário em BackupService.pgEnv().`
        : rawMessage;
      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Restore database from backup
   */
  async restoreBackup(backupFilePath: string): Promise<{ success: boolean; error?: string }> {
    // `pg_restore -c` sobre o banco em uso APAGA e recria objetos: em produção a API nunca faz isso (procedimento de DBA em banco novo e isolado).
    if (process.env.NODE_ENV === 'production') {
      return { success: false, error: 'RESTORE_DISABLED: a restauração é procedimento de DBA em banco isolado, nunca pela API.' };
    }
    try {
      logger.info(`Starting database restore from: ${backupFilePath}`);

      // Defesa em profundidade: mesmo que o chamador atual (rota /restore)
      // já resolva o path através de listBackups() (nunca aceita path cru
      // do usuário), este serviço não deveria confiar cegamente em
      // qualquer caminho recebido — um path fora de backupDir nunca deveria
      // ser restaurado a partir daqui.
      const resolvedBackupDir = path.resolve(this.config.backupDir);
      const resolvedPath = path.resolve(backupFilePath);
      if (!resolvedPath.startsWith(resolvedBackupDir + path.sep)) {
        return { success: false, error: 'Invalid backup file path' };
      }

      // Verify backup file exists
      await fs.access(resolvedPath);

      // PostgreSQL restore command
      const command = `${this.pgBin('pg_restore')} -h ${this.config.host} -p ${this.config.port} -U ${this.config.username} -d ${this.config.database} -c "${resolvedPath}"`;

      // Execute restore
      await execAsync(command, { env: this.pgEnv() });

      logger.info('Database restored successfully');

      return { success: true };
    } catch (error) {
      logger.error('Restore failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * List available backups
   */
  async listBackups(): Promise<
    Array<{ filename: string; path: string; size: number; createdAt: Date }>
  > {
    try {
      const files = await fs.readdir(this.config.backupDir);
      const backups = [];

      for (const file of files) {
        if (file.endsWith('.sql')) {
          const filePath = path.join(this.config.backupDir, file);
          const stats = await fs.stat(filePath);

          backups.push({
            filename: file,
            path: filePath,
            size: stats.size,
            createdAt: stats.birthtime,
          });
        }
      }

      // Sort by creation date (newest first)
      backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      return backups;
    } catch (error) {
      logger.error('Failed to list backups:', error);
      return [];
    }
  }

  /**
   * Delete old backups
   */
  private async cleanOldBackups(retentionDays: number): Promise<void> {
    try {
      const backups = await this.listBackups();
      const now = new Date();
      const maxAge = retentionDays * 24 * 60 * 60 * 1000; // Convert days to milliseconds

      for (const backup of backups) {
        const age = now.getTime() - backup.createdAt.getTime();

        if (age > maxAge) {
          await fs.unlink(backup.path);
          logger.info(`Deleted old backup: ${backup.filename}`);
        }
      }
    } catch (error) {
      logger.error('Failed to clean old backups:', error);
    }
  }

  /**
   * Delete a specific backup
   *
   * ANTES DESTA CORREÇÃO: `filename` vinha direto de `req.params` na rota
   * DELETE /api/backup/delete/:filename sem qualquer validação, e
   * `path.join(backupDir, filename)` com um filename como
   * "../../../../etc/passwd" resolve para FORA do diretório de backups —
   * um usuário com a permissão `backup:delete` conseguia apagar QUALQUER
   * arquivo que o processo Node tivesse permissão de escrita (path
   * traversal / exclusão arbitrária de arquivo). Agora validamos o formato
   * do nome E confirmamos que o caminho resolvido continua dentro de
   * backupDir antes de deletar.
   */
  async deleteBackup(filename: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (!/^[a-zA-Z0-9_.-]+\.sql$/.test(filename)) {
        return { success: false, error: 'Invalid backup filename' };
      }

      const resolvedBackupDir = path.resolve(this.config.backupDir);
      const filePath = path.resolve(resolvedBackupDir, filename);

      if (!filePath.startsWith(resolvedBackupDir + path.sep)) {
        logger.error(`Path traversal attempt blocked for backup deletion: ${filename}`);
        return { success: false, error: 'Invalid backup filename' };
      }

      await fs.unlink(filePath);
      logger.info(`Backup deleted: ${filename}`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete backup:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get backup statistics
   */
  async getBackupStats(): Promise<{
    totalBackups: number;
    totalSize: number;
    oldestBackup?: Date;
    newestBackup?: Date;
  }> {
    const backups = await this.listBackups();

    if (backups.length === 0) {
      return { totalBackups: 0, totalSize: 0 };
    }

    const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);

    return {
      totalBackups: backups.length,
      totalSize,
      oldestBackup: backups[backups.length - 1].createdAt,
      newestBackup: backups[0].createdAt,
    };
  }
}

// Create singleton instance — variáveis DATABASE_HOST/PORT/NAME/USER/
// PASSWORD individuais têm prioridade quando definidas explicitamente
// (permite apontar o backup para uma réplica/host diferente do banco
// principal, se algum dia for necessário); na ausência delas, deriva de
// DATABASE_URL (a mesma fonte de verdade que o Prisma usa) em vez de cair
// em defaults que nunca bateram com o banco real deste projeto.
const fromUrl = parseDatabaseUrl();
const localBackupService = new BackupService({
  host: process.env.DATABASE_HOST || fromUrl.host || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || String(fromUrl.port || 5432), 10),
  database: process.env.DATABASE_NAME || fromUrl.database || 'lnsystem',
  username: process.env.DATABASE_USER || fromUrl.username || 'postgres',
  password: process.env.DATABASE_PASSWORD || fromUrl.password || 'postgres',
  backupDir: process.env.BACKUP_DIR || './backups',
  pgBinDir: process.env.PG_BIN_DIR || undefined,
});

// Modo de backup (decisão 152): sem credencial de backup na API (produção), quem faz o backup é o serviço dedicado e a API só o PEDE e o LISTA.
export const backupService: BackupFacade =
  resolveBackupMode(process.env) === 'delegated'
    ? new DelegatedBackupService({ requestDir: process.env.BACKUP_REQUEST_DIR || undefined, publicDir: process.env.BACKUP_PUBLIC_DIR || undefined })
    : localBackupService;
