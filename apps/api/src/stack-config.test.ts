import * as fs from 'fs';
import * as path from 'path';

/**
 * CONFIGURAÇÃO DA PILHA (compose + scripts), sem Docker/banco. Achados da 1ª execução real da pilha (workflow stack-smoke):
 *  - o serviço `api` usava `env_file: .env` e recebia TODAS as senhas (superusuário, dono das tabelas, credencial de backup com BYPASSRLS),
 *    anulando a separação de papéis (decisão 152);
 *  - `as_app`/`sa` do roteiro de homologação perdiam o código de saída no pipe (todo `must_fail` reprovava mesmo com o banco negando);
 *  - `base-backup.sh` conectava como "postgres", role que não existe no compose (o superusuário é POSTGRES_USER).
 */
const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const compose = read('docker-compose.yml');

const serviceBlock = (name: string): string => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`serviço ${name} não encontrado`);
  const rest = compose.slice(start + 1);
  const next = /\n {2}[a-z][a-z-]*:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
};
const apiEnvKeys = (): Set<string> => {
  const block = serviceBlock('api');
  const env = /\n {4}environment:\n([\s\S]*?)(?=\n {4}[a-z_]+:)/.exec(block);
  if (!env) throw new Error('bloco environment do serviço api não encontrado');
  return new Set([...env[1].matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]));
};

// credenciais/ajustes de INFRAESTRUTURA e de teste: nunca no ambiente da API
const INFRA = /^(POSTGRES_|DB_(OWNER|APP|BACKUP)_|BACKUP_KEY_FILE|BACKUP_OFFSITE_CMD|BACKUP_ALERT_CMD|ALERT_WEBHOOK_URL|WAL_|RCLONE_|BACKUP_DATABASE_URL|RESTORE_|CORTEX_DB_ADMIN_URL|PROVISION_DATABASE_URL|TEST_|JEST_|RATE_LIMIT_TEST_MODE|DRILL_|CTX_DEBUG|CHECK_RLS_|PG_BIN_DIR|DATABASE_(HOST|NAME|PASSWORD|PORT|USER)|BACKUP_DIR|BACKUP_ENCRYPTION_KEY_FILE|ALLOW_API_BACKUP_CREDENTIAL|ALLOW_PRIVILEGED_DB_ROLE|PUBLIC_API_URL|NEXT_PUBLIC_|SUPER_ADMIN_PORT|ADMIN_WEB_PORT|DEV_CORS_ORIGINS|STAGING_DOMAIN|ORIGIN_CERT_DIR)/;

describe('serviço api do docker-compose.yml', () => {
  it('não usa env_file (o .env inteiro, com as senhas de infraestrutura, não pode chegar à API)', () => {
    expect(serviceBlock('api')).not.toMatch(/^\s*env_file:/m);
    expect(compose).not.toMatch(/^\s*env_file:/m);
  });

  it('não recebe nenhuma credencial de infraestrutura (superusuário, dono, backup, WAL)', () => {
    const keys = [...apiEnvKeys()];
    expect(keys.filter((k) => INFRA.test(k))).toEqual([]);
  });

  it('recebe toda variável de aplicação que o código lê (senão ela seria ignorada em silêncio)', () => {
    const keys = apiEnvKeys();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(REPO, 'apps/api/src'));
    walk(path.join(REPO, 'packages/shared'));
    walk(path.join(REPO, 'packages/database/src'));
    const used = new Set<string>();
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/\b(?:process\.env|env|e)\.([A-Z][A-Z0-9_]{2,})\b/g)) used.add(m[1]);
      for (const m of t.matchAll(/\b(?:process\.env|env|e)\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) used.add(m[1]);
    }
    const missing = [...used].filter((n) => !INFRA.test(n) && !keys.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it('mantém as variáveis que o compose define de propósito (papel sem posse, modo delegado, contexto assinado)', () => {
    const keys = apiEnvKeys();
    for (const k of ['DATABASE_URL', 'BACKUP_MODE', 'RLS_CONTEXT_SECRET', 'REQUIRE_NON_OWNER_DB_ROLE', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATA_ENCRYPTION_KEY']) {
      expect({ k, tem: keys.has(k) }).toEqual({ k, tem: true });
    }
    const block = serviceBlock('api');
    expect(block).toMatch(/DATABASE_URL: "postgresql:\/\/\$\{DB_APP_USER:-lnsystem_app\}:/);
    const semComentarios = block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(semComentarios).not.toMatch(/DB_OWNER|DB_BACKUP|POSTGRES_PASSWORD|POSTGRES_USER/);
  });
});

describe('scripts da pilha', () => {
  it('o roteiro de homologação não perde o código de saída do psql no pipe (must_fail funciona)', () => {
    const s = read('deploy/homologacao/validar-homologacao.sh');
    expect(s).toMatch(/\nas_app\(\) \{ _o=\$\(dc exec[^\n]*\) \|\| return 1;/);
    expect(s).toMatch(/\nsa\(\) \{ _o=\$\(dc exec[^\n]*\) \|\| return 1;/);
    expect(s).not.toMatch(/\nas_app\(\) \{ dc exec[^\n]*\| tr/);
  });

  it('o base-backup.sh conecta com o superusuário do contêiner (POSTGRES_USER), não com a role "postgres"', () => {
    const s = read('deploy/backup/base-backup.sh');
    expect(s).toMatch(/export PGUSER="\$\{PGUSER:-\$\{POSTGRES_USER:-postgres\}\}"/);
  });
});
