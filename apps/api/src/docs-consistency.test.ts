import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * COERÊNCIA DA DOCUMENTAÇÃO DO BANCO COM O REPOSITÓRIO (sem banco, sem rede).
 * Motivo: a entrega de 2026-10-15 declarava 50 migrations, mas um documento disponível ainda dizia 40 e listava como pendentes itens já
 * corrigidos. Este teste impede a deriva: contagem de migrations, ausência de afirmações superadas nos documentos VIGENTES, links internos
 * que resolvem, decisões 128–140 sem "AGUARDANDO", todas as migrations listadas no relatório e — quando o pacote existe — o SHA-256 do ZIP
 * igual ao do manifesto.
 */
const REPO = path.resolve(__dirname, '../../..');
const DOCS = path.join(REPO, 'docs/CORTEX');
const MIG_DIR = path.join(REPO, 'packages/database/prisma/migrations');
const read = (rel: string) => fs.readFileSync(path.join(DOCS, rel), 'utf8').replace(/\r\n/g, '\n');
const migrations = fs.readdirSync(MIG_DIR).filter((d) => fs.statSync(path.join(MIG_DIR, d)).isDirectory()).sort();

// documentos que descrevem o estado ATUAL (não os históricos datados)
const CURRENT_DOCS = [
  'BANCO_DE_DADOS.md',
  'REVISAO_BANCO_PENDENCIAS.md',
  'RELATORIO_EXECUCAO_REVISAO_BANCO.md',
  'RELATORIO_MIGRATIONS.md',
  'MAPA_RELACIONAMENTOS.md',
  'CURRENT_STATE.md',
  'README.md',
  'contracts/tenant-branch-scope.md',
  'contracts/permission-matrix.md',
  'BACKUP_RECUPERACAO.md',
  'RELATORIO_FINALIZACAO_PRODUCAO.md',
];

describe('documentação do banco × repositório', () => {
  it('as migrations do repositório são 57 e cada uma aparece no RELATORIO_MIGRATIONS', () => {
    expect(migrations).toHaveLength(57);
    const rel = read('RELATORIO_MIGRATIONS.md');
    const missing = migrations.filter((m) => !rel.includes(m));
    expect(missing).toEqual([]);
  });

  it('os documentos principais declaram a contagem real de migrations', () => {
    const n = migrations.length;
    for (const f of ['BANCO_DE_DADOS.md', 'REVISAO_BANCO_PENDENCIAS.md', 'RELATORIO_EXECUCAO_REVISAO_BANCO.md', 'RELATORIO_MIGRATIONS.md', 'CURRENT_STATE.md']) {
      expect({ f, ok: new RegExp(`\\b${n}\\b`).test(read(f)) }).toEqual({ f, ok: true });
    }
    expect(read('BANCO_DE_DADOS.md')).toMatch(new RegExp(`as \\*\\*${n}\\*\\* migrations aplicadas do zero`));
  });

  it('nenhum documento vigente afirma o estado superado (40 migrations, refresh_tokens em texto, pendências já corrigidas)', () => {
    const stale: Array<[RegExp, string]> = [
      [/\b40 migra(ções|tions)\b/, '40 migrations'],
      [/\b36 migra(ções|tions)\b/, '36 migrations'],
      [/aguarda decisão 128/i, 'refresh_tokens aguardando decisão'],
      [/\*\*AGUARDANDO DECISÃO\*\* \(Alta\)/, 'item Alta aguardando decisão'],
      [/R1–R16/, 'riscos R1–R16 em aberto'],
      [/refresh_tokens.{0,40}sem isolamento por empresa e com o token em texto/i, 'refresh_tokens sem isolamento'],
    ];
    const hits: string[] = [];
    for (const f of CURRENT_DOCS) {
      const text = read(f);
      for (const [rx, label] of stale) {
        // linhas que descrevem o estado ANTERIOR de propósito (histórico/cenário "até a anterior") são marcadas e ignoradas
        const offending = text.split('\n').filter((l) => rx.test(l) && !/histórico|HISTÓRICO|até a anterior|superad/i.test(l));
        if (offending.length) hits.push(`${f}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('as decisões 128 a 140 não estão "AGUARDANDO DECISÃO"; as que dependem do dono ou da infraestrutura estão marcadas assim', () => {
    const decisions = read('DECISIONS.md').split('\n');
    for (let n = 128; n <= 140; n++) {
      const row = decisions.find((l) => l.startsWith(`| ${n} |`));
      expect({ n, found: !!row }).toEqual({ n, found: true });
      expect({ n, aguardando: /AGUARDANDO DECIS/.test(row!) && n !== 135 }).toEqual({ n, aguardando: false });
    }
    for (const n of [141, 142]) {
      const row = decisions.find((l) => l.startsWith(`| ${n} |`))!;
      expect(row).toMatch(/PENDENTE-(DECISÃO|INFRA)/);
    }
  });

  it('as decisões 143 a 148 e 151 a 155 (escopo por filial, travas, compose, contexto assinado, backup delegado, multi-filial, WAL/PITR, anonimização) estão concluídas; 149, 150 e 156 (backup/infra) ficam pendentes e dizem isso', () => {
    const decisions = read('DECISIONS.md').split('\n');
    for (const n of [143, 144, 145, 146, 147, 148, 151, 152, 153, 154, 155]) {
      const row = decisions.find((l) => l.startsWith(`| ${n} |`));
      expect({ n, found: !!row }).toEqual({ n, found: true });
      expect({ n, concluida: /CONCLUÍDA/.test(row!) }).toEqual({ n, concluida: true });
    }
    expect(decisions.find((l) => l.startsWith('| 149 |'))).toMatch(/PENDENTE-DECISÃO/);
    expect(decisions.find((l) => l.startsWith('| 150 |'))).toMatch(/PENDENTE-INFRA/);
    const infra = decisions.find((l) => l.startsWith('| 156 |'))!;
    expect(infra).toMatch(/PENDENTE-INFRA/);
    expect(infra).toMatch(/não executad/i); // o Compose/staging/off-site nunca são declarados validados sem execução
    expect(decisions.find((l) => l.startsWith('| 154 |'))).toMatch(/NÃO APROVADAS/); // RPO/RTO seguem como proposta
  });

  it('as decisões 157 a 160 (senha temporária, ciclo de uso, apps Android, PDV Electron) estão concluídas e dizem o que NÃO foi comprovado; a 161 (comercial) fica com o proprietário', () => {
    const decisions = read('DECISIONS.md').split('\n');
    for (const n of [157, 158, 159, 160]) {
      const row = decisions.find((l) => l.startsWith(`| ${n} |`));
      expect({ n, found: !!row }).toEqual({ n, found: true });
      expect({ n, concluida: /CONCLUÍDA/.test(row!) }).toEqual({ n, concluida: true });
    }
    expect(decisions.find((l) => l.startsWith('| 159 |'))).toMatch(/Não comprovado/); // TV em aparelho, AAB e assinatura de produção
    expect(decisions.find((l) => l.startsWith('| 160 |'))).toMatch(/Sem assinatura de código/);
    expect(decisions.find((l) => l.startsWith('| 161 |'))).toMatch(/PENDENTE-DECISÃO/);
    expect(fs.existsSync(path.join(DOCS, 'PREPARACAO_COMERCIAL.md'))).toBe(true);
  });

  it('o backup tem script, agenda, ensaio de restauração e documento; o RPO/RTO está proposto e marcado como pendente de aprovação', () => {
    for (const f of ['deploy/backup/backup.sh', 'deploy/backup/entrypoint.sh', 'deploy/backup/Dockerfile', 'deploy/postgres-init/10-roles.sh', 'deploy/postgres-init/after-migrate.sql', 'apps/api/scripts/restore-drill.ts',
      'deploy/backup/wal-archive.sh', 'deploy/backup/wal-fetch.sh', 'deploy/backup/base-backup.sh', 'deploy/backup/pitr-restore.sh', 'deploy/backup/alert-webhook.sh',
      'docker-compose.wal.yml', 'deploy/homologacao/validar-homologacao.sh', 'apps/api/scripts/anonymize-restored.ts', 'docs/CORTEX/RLS_CONTEXTO_ASSINADO.md']) {
      expect({ f, existe: fs.existsSync(path.join(REPO, f)) }).toEqual({ f, existe: true });
    }
    const doc = read('BACKUP_RECUPERACAO.md');
    expect(doc).toMatch(/RPO/);
    expect(doc).toMatch(/RTO/);
    expect(doc).toMatch(/PENDENTE DE APROVAÇÃO/);
    const script = fs.readFileSync(path.join(REPO, 'deploy/backup/backup.sh'), 'utf8');
    expect(script).toMatch(/pg_dump -Fc/);
    expect(script).not.toMatch(/PGPASSWORD=['"]?[A-Za-z0-9]{6,}/); // nenhuma senha escrita no script
  });

  it('o compose não conecta nenhum serviço como superusuário e o backup usa papel próprio', () => {
    const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8');
    const apiDb = /api:[\s\S]*?DATABASE_URL: "postgresql:\/\/\$\{DB_APP_USER/.test(compose);
    const migrateDb = /migrate:[\s\S]*?DATABASE_URL: "postgresql:\/\/\$\{DB_OWNER_USER/.test(compose);
    expect({ apiDb, migrateDb }).toEqual({ apiDb: true, migrateDb: true });
    expect(compose).not.toMatch(/DATABASE_URL: "postgresql:\/\/\$\{POSTGRES_USER/);
    // decisão 152: a API NÃO recebe a credencial de backup; só o serviço `backup` tem o papel BYPASSRLS
    expect(compose).not.toMatch(/BACKUP_DATABASE_URL/);
    const apiBlock = compose.split(/\n {2}api:\n/)[1].split(/\n {2}admin-web:\n/)[0];
    expect(apiBlock).toMatch(/BACKUP_MODE: "delegated"/);
    expect(apiBlock).toMatch(/REQUIRE_NON_OWNER_DB_ROLE: "true"/);
    expect(apiBlock).toMatch(/RLS_CONTEXT_SECRET:/);
    expect(apiBlock).not.toMatch(/DB_BACKUP_(USER|PASSWORD)/);
    expect(apiBlock).toMatch(/backup_public:\/backup-public:ro/); // manifestos em somente leitura
    const backupBlock = compose.split(/\n {2}backup:\n/)[1].split(/\nvolumes:\n/)[0];
    expect(backupBlock).toMatch(/PGUSER: \$\{DB_BACKUP_USER/);
  });

  it('o overlay de WAL cifra o arquivo, não monta credencial do banco e exige a chave fora do repositório; nenhum script embute segredo', () => {
    const wal = fs.readFileSync(path.join(REPO, 'docker-compose.wal.yml'), 'utf8');
    expect(wal).toMatch(/archive_mode=on/);
    expect(wal).toMatch(/WAL_ENCRYPTION_KEY_FILE/);
    expect(wal).toMatch(/WAL_KEY_FILE:\?/); // obrigatória
    expect(wal).toMatch(/NÃO validado|não validado/i);
    for (const f of ['wal-archive.sh', 'wal-fetch.sh', 'base-backup.sh', 'pitr-restore.sh', 'alert-webhook.sh', 'backup.sh']) {
      const text = fs.readFileSync(path.join(REPO, 'deploy/backup', f), 'utf8');
      expect({ f, senha: /(PASSWORD|SECRET|TOKEN)=['"]?[A-Za-z0-9+/]{12,}/.test(text) }).toEqual({ f, senha: false });
    }
    expect(fs.readFileSync(path.join(REPO, 'deploy/backup/wal-archive.sh'), 'utf8')).toMatch(/nunca sobrescreve/i);
    expect(fs.readFileSync(path.join(REPO, 'deploy/backup/pitr-restore.sh'), 'utf8')).toMatch(/já existe — recusado/);
  });

  it('o roteiro de homologação não se declara executado e o .env.example documenta o segredo do contexto, o modo de backup e o alerta', () => {
    const script = fs.readFileSync(path.join(REPO, 'deploy/homologacao/validar-homologacao.sh'), 'utf8');
    expect(script).toMatch(/NÃO FOI EXECUTADO/);
    expect(script).toMatch(/docker compose config/);
    const envExample = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
    for (const key of ['RLS_CONTEXT_SECRET', 'BACKUP_MODE', 'ALERT_WEBHOOK_URL', 'WAL_KEY_FILE']) expect({ key, tem: envExample.includes(key) }).toEqual({ key, tem: true });
    expect(envExample).not.toMatch(/^RLS_CONTEXT_SECRET="[A-Za-z0-9+/=]{20,}"/m); // nenhum valor real no exemplo
  });

  it('os links internos dos documentos vigentes resolvem para arquivos que existem', () => {
    const broken: string[] = [];
    for (const f of CURRENT_DOCS) {
      const dir = path.dirname(path.join(DOCS, f));
      for (const m of read(f).matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
        const target = decodeURI(m[1].split('#')[0]);
        if (!target) continue;
        if (!fs.existsSync(path.resolve(dir, target))) broken.push(`${f} → ${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('o pacote ZIP final, quando existe, tem o SHA-256 igual ao do manifesto', () => {
    const zip = path.join(DOCS, 'CORTEX-finalizacao-producao-2026-10-15.zip');
    const manifest = path.join(DOCS, 'SHA256SUMS-finalizacao-producao-2026-10-15.txt');
    if (!fs.existsSync(zip) || !fs.existsSync(manifest)) return; // gerado no fechamento; sem ele não há o que conferir
    const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    const line = fs.readFileSync(manifest, 'utf8').split(/\r?\n/).find((l) => l.endsWith('CORTEX-finalizacao-producao-2026-10-15.zip'));
    expect(line).toBeDefined();
    expect(line!.slice(0, 64)).toBe(actual);
  });

  it('o pacote da missão de segurança, quando existe, tem o SHA-256 do manifesto e o relatório final aponta para ele', () => {
    const zip = path.join(DOCS, 'CORTEX-seguranca-producao-2026-10-15.zip');
    const manifest = path.join(DOCS, 'SHA256SUMS-seguranca-producao-2026-10-15.txt');
    expect(read('RELATORIO_SEGURANCA_PRODUCAO_2026-10-15.md')).toMatch(/SHA256SUMS-seguranca-producao-2026-10-15\.txt/);
    if (!fs.existsSync(zip) || !fs.existsSync(manifest)) return; // gerado no fechamento
    const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    const line = fs.readFileSync(manifest, 'utf8').split(/\r?\n/).find((l) => l.endsWith('CORTEX-seguranca-producao-2026-10-15.zip'));
    expect(line).toBeDefined();
    expect(line!.slice(0, 64)).toBe(actual);
  });
});
