import * as fs from 'fs';
import * as path from 'path';

/**
 * REGRESSÃO DO PIPELINE DE CI (sem rede, sem Docker, sem banco).
 * Motivo: o workflow nunca tinha rodado de verdade; a 1ª execução remota (commit 5e9b941) falhou em 4 jobs por defeitos de configuração,
 * todos reproduzidos localmente. Este teste impede que voltem:
 *  - jobs que usam `@ln-system/database` / o cliente Prisma sem gerar o cliente e compilar shared/database ("Cannot find module
 *    '@ln-system/database'", 80+ suítes unitárias vermelhas, typecheck vermelho);
 *  - `docker compose config` sem o `.env` que o serviço `api` exige via `env_file` ("env file .env not found");
 *  - o workflow sem `permissions` explícitas (GITHUB_TOKEN com o padrão do repositório).
 */
const REPO = path.resolve(__dirname, '../../..');
const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n');

const jobBlock = (name: string): string => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`job ${name} não encontrado em ci.yml`);
  const rest = ci.slice(start + 1);
  const next = /\n {2}[a-z][a-z-]*:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
};

describe('workflow de CI × repositório', () => {
  it('os jobs que typecheckam, testam ou rodam scripts tsx geram o cliente Prisma e compilam shared/database ANTES', () => {
    for (const name of ['lint-and-typecheck', 'unit-tests', 'integration-tests']) {
      const block = jobBlock(name);
      const gen = block.indexOf('npx prisma generate --schema=packages/database/prisma/schema.prisma');
      expect({ name, geraPrisma: gen >= 0 }).toEqual({ name, geraPrisma: true });
      expect({ name, buildShared: block.includes('npm run build --workspace=@ln-system/shared') }).toEqual({ name, buildShared: true });
      expect({ name, buildDatabase: block.includes('npm run build --workspace=@ln-system/database') }).toEqual({ name, buildDatabase: true });
      const firstUse = ['npm run type-check', 'npm test', 'db:role-split-check', 'test:integration', 'db:check-rls']
        .map((token) => block.indexOf(token))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0];
      expect({ name, geraAntesDoPrimeiroUso: firstUse === undefined || gen < firstUse }).toEqual({ name, geraAntesDoPrimeiroUso: true });
    }
  });

  it('o job de infra cria o .env a partir do .env.example (fluxo documentado, lido pelo compose para interpolar) antes de validar o compose', () => {
    expect(compose).toContain('${DB_APP_PASSWORD');
    const block = jobBlock('infra-static');
    const copy = block.indexOf('cp .env.example .env');
    const firstConfig = block.indexOf('docker compose -f');
    expect(copy).toBeGreaterThan(-1);
    expect(firstConfig).toBeGreaterThan(copy);
    expect(fs.existsSync(path.join(REPO, '.env.example'))).toBe(true);
  });

  it('o job de infra valida o overlay WAL e as demais combinações documentadas com `config -q`', () => {
    const block = jobBlock('infra-static');
    for (const combo of ['-f docker-compose.yml config -q', '-f docker-compose.staging.yml config -q', '-f docker-compose.wal.yml config -q']) {
      expect({ combo, presente: block.includes(combo) }).toEqual({ combo, presente: true });
    }
    expect(block).toMatch(/WAL_KEY_FILE:/);
  });

  it('as invariantes de RLS rodam como papel SEM posse com o contexto assinado provisionado, e a suíte completa nunca roda como superusuário', () => {
    const block = jobBlock('integration-tests');
    const prov = block.indexOf('npm run db:provision-context');
    const check = block.indexOf('npm run db:check-rls');
    expect(prov).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(prov);
    expect(block).toMatch(/CREATE ROLE cortex_ci_runtime[^;]*NOSUPERUSER[^;]*NOBYPASSRLS/);
    expect(block).toContain('db:role-split-check -- --all');
    // o usuário do serviço Postgres é superusuário e superusuário ignora a RLS: os testes que exigem NEGAÇÃO reprovam por construção
    expect(block).not.toMatch(/npm run test:integration/);
  });

  it('o db-role-split-check prova a negação de SET ROLE com papéis que EXISTEM (administrativo e dono), não com o literal "postgres"', () => {
    // no Postgres do CI o superusuário é `lnsystem` e não há role "postgres": o erro vira "role does not exist" e a prova de negação falha por motivo errado
    const script = fs.readFileSync(path.join(REPO, 'apps/api/scripts/db-role-split-check.ts'), 'utf8');
    expect(script).not.toMatch(/SET ROLE postgres/);
    expect(script).toContain('SET ROLE "${adminRole}"');
    expect(script).toContain('SET ROLE "${owner}"');
  });

  it('o workflow declara permissões mínimas (somente leitura) e não usa segredos do repositório', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(ci).not.toMatch(/\$\{\{\s*secrets\./);
    expect(ci).not.toMatch(/pull_request_target/);
  });
});
