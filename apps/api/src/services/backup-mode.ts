/**
 * MODO DE BACKUP da API (decisão 152).
 *  - `delegated` (padrão quando a API NÃO tem credencial de backup): quem faz o backup é o SERVIÇO DEDICADO (`deploy/backup`), com credencial própria. A API só
 *    PEDE um backup (arquivo em `BACKUP_REQUEST_DIR`, que o serviço consome) e LISTA os manifestos publicados em `BACKUP_PUBLIC_DIR` (somente leitura). Não
 *    executa `pg_dump`, não lê nem apaga arquivo de backup, não restaura. A credencial que lê todas as empresas (BYPASSRLS) não existe no processo da API.
 *  - `local` (desenvolvimento): a API tem `BACKUP_DATABASE_URL` e faz o `pg_dump` ela mesma (como antes). Em produção é recusado (config/env.ts) salvo a exceção
 *    explícita `ALLOW_API_BACKUP_CREDENTIAL=true`.
 */
export type BackupMode = 'local' | 'delegated';

export function resolveBackupMode(env: NodeJS.ProcessEnv = process.env): BackupMode {
  const explicit = env.BACKUP_MODE?.trim().toLowerCase();
  if (explicit === 'local' || explicit === 'delegated') return explicit;
  return env.BACKUP_DATABASE_URL && env.BACKUP_DATABASE_URL.trim() ? 'local' : 'delegated';
}
