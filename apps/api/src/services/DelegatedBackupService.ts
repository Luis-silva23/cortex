import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { logger } from '../utils/logger';

/**
 * BACKUP DELEGADO (decisão 152): a API NÃO tem a credencial que lê todas as empresas. Quem faz o `pg_dump` é o serviço `backup` (deploy/backup), com papel próprio.
 * Aqui a API só:
 *  - PEDE um backup: grava `request-<ISO>-<8 hex>.json` em `BACKUP_REQUEST_DIR` (diretório que o serviço consome a cada minuto; a API só cria arquivo, não lista);
 *  - LISTA os backups pelos MANIFESTOS publicados em `BACKUP_PUBLIC_DIR` (montado SOMENTE LEITURA na API; só metadados — nome, tamanho, instante, se está cifrado —
 *    nunca o arquivo de backup);
 *  - NÃO restaura e NÃO apaga (restaurar é procedimento de DBA em banco isolado; a retenção é do serviço de backup, com proteção contra exclusão no destino).
 * Quem comprometer a API consegue, no máximo, PEDIR mais um backup (o serviço limita a frequência); não lê, não apaga e não corrompe backup algum.
 */
export interface DelegatedBackupConfig {
  requestDir?: string;
  publicDir?: string;
}

export interface BackupListItem {
  filename: string;
  path: string;
  size: number;
  createdAt: Date;
}

/** `20261015T084158Z` → Date (UTC). */
export function parseBackupStamp(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  // Date.UTC rola mês/dia inválidos (99 vira outro ano): só vale se o instante lido volta igual
  return Number.isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] ? null : d;
}

/** Interpreta um manifesto `chave=valor` (uma por linha) do `backup.sh`. */
export function parseManifest(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const SAFE_ID = /[^A-Za-z0-9_-]/g;

export class DelegatedBackupService {
  readonly mode = 'delegated' as const;
  constructor(private readonly config: DelegatedBackupConfig) {}

  async createBackup(requestedBy?: string): Promise<{ success: boolean; requested?: boolean; requestId?: string; filePath?: string; error?: string }> {
    if (!this.config.requestDir) {
      return { success: false, error: 'BACKUP_REQUEST_DIR não configurado: a API não tem como pedir o backup ao serviço dedicado (deploy/backup).' };
    }
    try {
      const requestId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
      const file = path.join(this.config.requestDir, `request-${requestId}.json`);
      // 0644: o serviço de backup (outro usuário do contêiner) precisa conseguir remover/reconhecer o arquivo; nada sensível vai nele
      await fs.writeFile(file, JSON.stringify({ requestId, requestedAt: new Date().toISOString(), requestedBy: String(requestedBy ?? '').replace(SAFE_ID, '').slice(0, 64) || null }), { mode: 0o644, flag: 'wx' });
      logger.info('Backup solicitado ao serviço dedicado', { requestId });
      return { success: true, requested: true, requestId };
    } catch (error) {
      logger.error('Falha ao pedir o backup ao serviço dedicado', { error: error instanceof Error ? error.message : String(error) });
      return { success: false, error: 'Não foi possível pedir o backup ao serviço dedicado (diretório de pedidos indisponível).' };
    }
  }

  async listBackups(): Promise<BackupListItem[]> {
    if (!this.config.publicDir) return [];
    try {
      const files = (await fs.readdir(this.config.publicDir)).filter((f) => f.endsWith('.manifest'));
      const items: BackupListItem[] = [];
      for (const f of files) {
        try {
          const m = parseManifest(await fs.readFile(path.join(this.config.publicDir, f), 'utf8'));
          const created = parseBackupStamp(m.criado_em ?? '');
          if (!m.arquivo || !created) continue;
          items.push({ filename: path.basename(m.arquivo), path: '', size: Number(m.bytes) || 0, createdAt: created });
        } catch {
          /* manifesto ilegível: ignora este, lista os demais */
        }
      }
      items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return items;
    } catch (error) {
      logger.error('Falha ao listar os manifestos de backup', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /** A API nunca restaura: é procedimento de DBA, em banco novo e isolado (docs/CORTEX/BACKUP_RECUPERACAO.md). */
  async restoreBackup(_backupFilePath: string): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'RESTORE_DISABLED: a restauração é procedimento de DBA em banco isolado, nunca pela API.' };
  }

  /** A API nunca apaga backup: a retenção é do serviço de backup e o destino externo tem proteção contra exclusão. */
  async deleteBackup(_filename: string): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'DELETE_DISABLED: a retenção dos backups é do serviço dedicado; a API não apaga backup.' };
  }

  async getBackupStats(): Promise<{ totalBackups: number; totalSize: number; oldestBackup?: Date; newestBackup?: Date }> {
    const backups = await this.listBackups();
    if (backups.length === 0) return { totalBackups: 0, totalSize: 0 };
    return {
      totalBackups: backups.length,
      totalSize: backups.reduce((s, b) => s + b.size, 0),
      oldestBackup: backups[backups.length - 1].createdAt,
      newestBackup: backups[0].createdAt,
    };
  }
}
