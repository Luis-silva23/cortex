/**
 * PROVA DE REPRODUTIBILIDADE DO BANCO: aplica TODAS as migrations versionadas num banco TEMPORÁRIO e VAZIO e compara o resultado com o
 * banco de desenvolvimento (colunas, índices, constraints, policies RLS, triggers) e com o schema Prisma. Se algo existir no dev e não vier
 * das migrations (alteração manual invisível), aparece como diferença.
 *
 *   npm run db:replay-check
 *
 * Segurança: cria `<banco-de-dev>_replay_tmp` (RECUSA se ele já existir — nunca apaga um banco que não criou), usa só esse banco e o remove
 * no fim. Não toca no banco de desenvolvimento nem no de teste (só leitura do catálogo). Não imprime URL/credencial.
 * Grava: docs/CORTEX/revisao-banco/replay-resultado.md e drift-dev.txt.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { spawnSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

import { contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const REPO = path.resolve(__dirname, '../../..');
const DB_PKG = path.join(REPO, 'packages/database');
const OUT = path.join(REPO, 'docs/CORTEX/revisao-banco');

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function signature(url: string): Promise<{ lines: string[]; version: string; notValid: string[] }> {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const q = async <T = any>(sql: string): Promise<T[]> => (await db.$queryRawUnsafe(sql)) as T[];
  try {
    const out: string[] = [];
    for (const r of await q<{ l: string }>(
      `SELECT 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS l
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname <> '_prisma_migrations'`
    )) out.push(r.l);
    for (const r of await q<{ l: string }>(`SELECT 'idx ' || indexdef AS l FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`)) out.push(r.l);
    // NOT VALID é estado de DADO (linha órfã legada que a migração preserva — ver `notValid` no resultado), não de estrutura: normalizado aqui
    for (const r of await q<{ l: string }>(
      `SELECT 'con ' || c.relname || ' ' || k.conname || ' ' || replace(pg_get_constraintdef(k.oid), ' NOT VALID', '') AS l FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname <> '_prisma_migrations'`
    )) out.push(r.l);
    for (const r of await q<{ l: string }>(`SELECT 'tz ' || current_setting('TimeZone') AS l`)) out.push(r.l);
    for (const r of await q<{ l: string }>(
      `SELECT 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' | ' || coalesce(with_check, '') AS l FROM pg_policies WHERE schemaname = 'public'`
    )) out.push(r.l);
    for (const r of await q<{ l: string }>(
      `SELECT 'rls ' || c.relname || ' enabled=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity AS l FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`
    )) out.push(r.l);
    for (const r of await q<{ l: string }>(`SELECT 'trg ' || pg_get_triggerdef(t.oid) AS l FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`)) out.push(r.l);
    for (const r of await q<{ l: string }>(`SELECT 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS l FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`)) out.push(r.l);
    for (const r of await q<{ l: string }>(`SELECT 'seq ' || sequencename AS l FROM pg_sequences WHERE schemaname = 'public'`)) out.push(r.l);
    for (const r of await q<{ l: string }>(`SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS l FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`)) out.push(r.l);
    const version = ((await q<{ v: string }>(`SELECT version() AS v`))[0]?.v ?? '').split(',')[0];
    const notValid = (await q<{ l: string }>(`SELECT c.relname || '.' || k.conname AS l FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.contype = 'f' AND NOT k.convalidated ORDER BY 1`)).map((r) => r.l);
    return { lines: out.sort(), version, notValid };
  } finally {
    await db.$disconnect();
  }
}

function prisma(args: string[], url: string) {
  return spawnSync('npx', ['prisma', ...args], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
}

/**
 * CENÁRIO COM DADOS (segundo banco temporário): aplica as migrations ATÉ a anterior à FK composta, grava uma linha SINTÉTICA que a viola
 * (código de barras da empresa A apontando para produto da B) e roda o `migrate deploy` completo. Esperado: a migration
 * `20261014155900_guard_product_children_same_company` FALHA, NADA das FKs compostas fica aplicado (atomicidade) e, depois de corrigir a linha e
 * `migrate resolve --rolled-back`, o deploy conclui. Prova que a migration não "funciona só em banco vazio" nem corrompe dado inconsistente.
 */
// A guarda roda ANTES das FKs compostas (nome menor): em banco com dado cruzado é ELA que falha, e a das FKs nem começa.
const FIRST_COMPOSITE_MIGRATION = '20261014155900_guard_product_children_same_company';

async function dataScenario(devUrl: string, admin: PrismaClient): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const devName = new URL(devUrl).pathname.replace(/^\//, '');
  const name = `${devName}_replay2_tmp`;
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`nome inválido: ${name}`);
  const exists = (await admin.$queryRawUnsafe(`SELECT 1 AS x FROM pg_database WHERE datname = '${name}'`)) as unknown[];
  if (exists.length) throw new Error(`o banco temporário "${name}" já existe — recusado.`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const url = withDatabase(devUrl, name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mig-'));
  let ok = true;
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    // 1. schema + migrations só até a anterior
    fs.mkdirSync(path.join(tmp, 'prisma', 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(DB_PKG, 'prisma', 'schema.prisma'), path.join(tmp, 'prisma', 'schema.prisma'));
    fs.copyFileSync(path.join(DB_PKG, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tmp, 'prisma', 'migrations', 'migration_lock.toml'));
    const all = fs.readdirSync(path.join(DB_PKG, 'prisma', 'migrations')).filter((d) => fs.statSync(path.join(DB_PKG, 'prisma', 'migrations', d)).isDirectory()).sort();
    const before = all.filter((d) => d < FIRST_COMPOSITE_MIGRATION);
    for (const d of before) fs.cpSync(path.join(DB_PKG, 'prisma', 'migrations', d), path.join(tmp, 'prisma', 'migrations', d), { recursive: true });
    // a pasta temporária fica FORA do repositório: `npx prisma` ali baixaria outra versão do CLI — usa o CLI instalado no monorepo
    const prismaCli = path.join(REPO, 'node_modules', 'prisma', 'build', 'index.js');
    const partial = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: tmp, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
    lines.push(`- Banco temporário 2: ${before.length} migrations aplicadas (até a anterior à FK composta): ${partial.status === 0 ? 'sucesso' : '**FALHOU**'}.`);
    if (partial.status !== 0) {
      lines.push('```\n' + `${partial.stdout}\n${partial.stderr}`.replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://***').split('\n').filter((l) => l.trim()).slice(-12).join('\n') + '\n```');
      return { ok: false, lines };
    }

    // 2. dados sintéticos: duas empresas, um produto em cada, e UM código de barras da A apontando para o produto da B (a FK antiga aceita)
    const sa = (ops: any[]) =>
      client.$transaction([
        contextStatement(client, PLATFORM_CONTEXT),
        ...ops,
      ]);
    const stamp = Date.now();
    const mkCompany = async (n: string, doc: string) => (await sa([client.company.create({ data: { name: `Teste migracao ${n}`, document: doc, email: `mig-${n}-${stamp}@teste.local`, isActive: true } })]))[1] as { id: string };
    const A = await mkCompany('A', String(stamp).slice(-8).padStart(14, '1'));
    const B = await mkCompany('B', String(stamp + 1).slice(-8).padStart(14, '2'));
    const mkProduct = async (c: string, sku: string) => (await sa([client.product.create({ data: { companyId: c, sku, name: sku, costPrice: 1, salePrice: 2, isActive: true } })]))[1] as { id: string };
    const pB = await mkProduct(B.id, `MIG-B-${stamp}`);
    await mkProduct(A.id, `MIG-A-${stamp}`);
    const bad = (await sa([client.productBarcode.create({ data: { companyId: A.id, productId: pB.id, code: `MIG-${stamp}` } })]))[1] as { id: string };
    // confere que a linha cruzada EXISTE de verdade antes do deploy (leitura como Super Admin, na mesma transação)
    const crossBefore = (await sa([client.$queryRawUnsafe(`SELECT count(*)::int AS n FROM product_barcodes b JOIN products p ON p.id = b."productId" WHERE p."companyId" <> b."companyId"`)]))[1] as Array<{ n: number }>;
    lines.push(`- Dados sintéticos: 2 empresas, 1 produto em cada e **1 código de barras da empresa A apontando para o produto da empresa B** (aceito pela FK antiga); linhas cruzadas confirmadas antes do deploy: ${crossBefore[0].n}.`);
    if (crossBefore[0].n !== 1) ok = false;

    // 3. deploy completo: a migration das FKs compostas tem que FALHAR
    const full = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    const failedAsExpected = full.status !== 0 && /product_children_same_company/.test(`${full.stdout}${full.stderr}`);
    lines.push(`- \`migrate deploy\` completo com a linha inconsistente: ${failedAsExpected ? '**falhou como esperado** (a migration `' + FIRST_COMPOSITE_MIGRATION + '` recusou o dado cruzado)' : '**NÃO falhou — inesperado**'}.`);
    if (!failedAsExpected) ok = false;

    // 4. atomicidade: nada da migration ficou aplicado
    const state = (await client.$queryRawUnsafe(`
      SELECT (SELECT count(*)::int FROM pg_indexes WHERE indexname = 'products_companyId_id_key') AS idx,
             (SELECT count(*)::int FROM pg_constraint WHERE conname = 'product_barcodes_companyId_productId_fkey') AS composite,
             (SELECT count(*)::int FROM pg_constraint WHERE conname = 'product_barcodes_productId_fkey') AS legacy`)) as Array<{ idx: number; composite: number; legacy: number }>;
    const atomic = state[0].idx === 0 && state[0].composite === 0 && state[0].legacy === 1;
    lines.push(`- Atomicidade: depois da falha, índice composto ${state[0].idx}, FK composta ${state[0].composite}, FK antiga ${state[0].legacy} → ${atomic ? '**nada ficou aplicado pela metade**' : '**ESTADO PARCIAL — investigar**'}.`);
    if (!atomic) ok = false;

    // 5. recuperação documentada: corrigir a linha (aqui: remover a linha sintética), marcar a migration como revertida e reaplicar
    await sa([client.productBarcode.deleteMany({ where: { id: bad.id, companyId: A.id } })]);
    const resolve = spawnSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', FIRST_COMPOSITE_MIGRATION], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    const redeploy = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    const final = (await client.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('product_barcodes_companyId_productId_fkey','product_images_companyId_productId_fkey')) AS composite`)) as Array<{ composite: number }>;
    const recovered = resolve.status === 0 && redeploy.status === 0 && final[0].composite === 2;
    lines.push(`- Recuperação (corrigir a linha → \`migrate resolve --rolled-back ${FIRST_COMPOSITE_MIGRATION}\` → \`migrate deploy\`): ${recovered ? '**concluiu**, as 2 FKs compostas existem' : '**FALHOU**'}.`);
    if (!recovered) ok = false;
  } finally {
    await client.$disconnect();
    try {
      await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
      await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
      lines.push('- Banco temporário 2 removido: sim.');
    } catch (e) {
      lines.push(`- **Banco temporário 2 NÃO removido** (${e instanceof Error ? e.message.split('\n').pop() : 'erro'}): \`DROP DATABASE "${name}"\` manual.`);
      ok = false;
    }
    // só a pasta temporária criada por este script; no Windows o motor do Prisma pode segurar um arquivo por instantes (EBUSY) — não derruba o resultado
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    } catch {
      lines.push(`- Pasta temporária \`${tmp}\` não pôde ser removida agora (arquivo em uso); pode ser apagada à mão (só contém cópia do schema e das migrations).`);
    }
  }
  return { ok, lines };
}

/**
 * CENÁRIO DE SESSÕES (terceiro banco temporário): estado ANTES da migration de refresh_tokens, com sessões "legadas" (token em texto,
 * companyId nulo). Prova que a migration (a) preserva as sessões — o hash calculado em SQL é igual ao SHA-256 calculado pela aplicação —,
 * (b) preenche companyId só pelo usuário (plataforma continua nulo), (c) remove a coluna em texto, e (d) ABORTA sem alterar nada se um token
 * já tiver empresa diferente da do usuário (nada é sobrescrito por suposição); depois de corrigir, o roteiro de recuperação conclui.
 */
const REFRESH_MIGRATION = '20261014170000_refresh_tokens_hash_and_company';

async function refreshScenario(devUrl: string, admin: PrismaClient): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const devName = new URL(devUrl).pathname.replace(/^\//, '');
  const name = `${devName}_replay3_tmp`;
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`nome inválido: ${name}`);
  const exists = (await admin.$queryRawUnsafe(`SELECT 1 AS x FROM pg_database WHERE datname = '${name}'`)) as unknown[];
  if (exists.length) throw new Error(`o banco temporário "${name}" já existe — recusado.`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const url = withDatabase(devUrl, name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mig-'));
  let ok = true;
  const client = new PrismaClient({ datasources: { db: { url } } });
  const prismaCli = path.join(REPO, 'node_modules', 'prisma', 'build', 'index.js');
  const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
  try {
    fs.mkdirSync(path.join(tmp, 'prisma', 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(DB_PKG, 'prisma', 'schema.prisma'), path.join(tmp, 'prisma', 'schema.prisma'));
    fs.copyFileSync(path.join(DB_PKG, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tmp, 'prisma', 'migrations', 'migration_lock.toml'));
    const all = fs.readdirSync(path.join(DB_PKG, 'prisma', 'migrations')).filter((d) => fs.statSync(path.join(DB_PKG, 'prisma', 'migrations', d)).isDirectory()).sort();
    const before = all.filter((d) => d < REFRESH_MIGRATION);
    for (const d of before) fs.cpSync(path.join(DB_PKG, 'prisma', 'migrations', d), path.join(tmp, 'prisma', 'migrations', d), { recursive: true });
    const partial = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: tmp, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
    lines.push(`- Banco temporário 3: ${before.length} migrations aplicadas (até a anterior à de refresh_tokens): ${partial.status === 0 ? 'sucesso' : '**FALHOU**'}.`);
    if (partial.status !== 0) return { ok: false, lines };

    // dados sintéticos: empresa A com usuário, empresa B, usuário de plataforma; sessões legadas (token em TEXTO, empresa nula)
    const sa = (ops: any[]) =>
      client.$transaction([
        contextStatement(client, PLATFORM_CONTEXT),
        ...ops,
      ]);
    const stamp = Date.now();
    const mkCompany = async (n: string, doc: string) =>
      (await sa([client.company.create({ data: { name: `Teste sessoes ${n}`, document: doc, email: `ses-${n}-${stamp}@teste.local`, isActive: true } })]))[1] as { id: string };
    const A = await mkCompany('A', String(stamp).slice(-8).padStart(14, '3'));
    const B = await mkCompany('B', String(stamp + 1).slice(-8).padStart(14, '4'));
    // SQL direto: o banco está ANTES de migrations posteriores, e o Prisma Client atual inclui colunas novas (ex.: mustChangePassword) no INSERT
    const mkUser = async (label: string, companyId: string | null, userType: string) =>
      ((await sa([client.$queryRaw`INSERT INTO users (id, "companyId", name, email, password, "userType", "isActive", "updatedAt") VALUES (gen_random_uuid()::text, ${companyId}, ${`Sessao ${label}`}, ${`ses-u-${label}-${stamp}@teste.local`}, ${'x'.repeat(60)}, ${userType}::"UserType", true, now()) RETURNING id`]))[1] as Array<{ id: string }>)[0];
    const uA = await mkUser('a', A.id, 'COMPANY_ADMIN');
    const uP = await mkUser('p', null, 'SUPER_ADMIN');
    const tokens = { a1: `legacy-A1-${stamp}.${'a'.repeat(40)}`, a2: `legacy-A2-${stamp}.${'b'.repeat(40)}`, p1: `legacy-P1-${stamp}.${'c'.repeat(40)}` };
    const exp = new Date(Date.now() + 7 * 864e5);
    const ins = (id: string, userId: string, token: string, companyId: string | null, revoked = false) =>
      client.$executeRaw`INSERT INTO refresh_tokens (id, "userId", "companyId", token, "expiresAt", "isRevoked") VALUES (${id}, ${userId}, ${companyId}, ${token}, ${exp}, ${revoked})`;
    await sa([ins(`rt-a1-${stamp}`, uA.id, tokens.a1, null), ins(`rt-a2-${stamp}`, uA.id, tokens.a2, null, true), ins(`rt-p1-${stamp}`, uP.id, tokens.p1, null)]);
    // 1) uma sessão da A gravada com a empresa da B (inconsistente): a migration tem que abortar
    await sa([client.$executeRaw`UPDATE refresh_tokens SET "companyId" = ${B.id} WHERE id = ${`rt-a2-${stamp}`}`]);
    lines.push('- Dados sintéticos: 3 sessões legadas (token em texto): 2 do usuário da empresa A e 1 de plataforma; **uma das sessões da A gravada com a empresa da B** (inconsistente).');

    const full1 = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    const aborted = full1.status !== 0 && /refresh_tokens_hash_and_company/.test(`${full1.stdout}${full1.stderr}`);
    lines.push(`- \`migrate deploy\` com sessão de empresa divergente: ${aborted ? '**abortou como esperado**' : '**NÃO abortou — inesperado**'}.`);
    if (!aborted) ok = false;
    const st = (await client.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'refresh_tokens' AND column_name = 'token') AS tem_token, (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'refresh_tokens' AND column_name = 'tokenHash') AS tem_hash`
    )) as Array<{ tem_token: number; tem_hash: number }>;
    const atomic = st[0].tem_token === 1 && st[0].tem_hash === 0;
    lines.push(`- Atomicidade: depois do aborto, coluna em texto ${st[0].tem_token ? 'ainda existe' : 'sumiu'} e coluna de hash ${st[0].tem_hash ? 'existe' : 'não existe'} → ${atomic ? '**nada ficou pela metade; nenhuma sessão perdida**' : '**ESTADO PARCIAL — investigar**'}.`);
    if (!atomic) ok = false;

    // 2) corrige a linha inconsistente (volta ao estado legado: empresa nula), marca a migration como revertida e reaplica
    await sa([client.$executeRaw`UPDATE refresh_tokens SET "companyId" = NULL WHERE id = ${`rt-a2-${stamp}`}`]);
    const resolve = spawnSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', REFRESH_MIGRATION], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    const full2 = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    lines.push(`- Recuperação (corrigir a linha → \`migrate resolve --rolled-back\` → \`migrate deploy\`): ${resolve.status === 0 && full2.status === 0 ? '**concluiu**' : '**FALHOU**'}.`);
    if (resolve.status !== 0 || full2.status !== 0) {
      ok = false;
      return { ok, lines };
    }

    // 3) verificação: hash igual ao da aplicação, empresa preenchida só pelo usuário, coluna em texto removida, segredo ausente da tabela
    const rows = (await sa([client.$queryRawUnsafe(`SELECT id, "tokenHash", "companyId", "isRevoked" FROM refresh_tokens ORDER BY id`)]))[1] as Array<{ id: string; tokenHash: string; companyId: string | null; isRevoked: boolean }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const hashOk = [['a1', tokens.a1], ['a2', tokens.a2], ['p1', tokens.p1]].every(([k, t]) => byId.get(`rt-${k}-${stamp}`)?.tokenHash === sha(t));
    lines.push(`- Sessões preservadas: o hash calculado em SQL é **igual** ao SHA-256 da aplicação nas 3 sessões → ${hashOk ? '**sim** (o mesmo token continua achando a mesma linha)' : '**NÃO**'}.`);
    if (!hashOk) ok = false;
    const companyOk = byId.get(`rt-a1-${stamp}`)?.companyId === A.id && byId.get(`rt-a2-${stamp}`)?.companyId === A.id && byId.get(`rt-p1-${stamp}`)?.companyId === null;
    lines.push(`- Empresa preenchida só pelo usuário: sessões da A → empresa A; sessão de plataforma → nula → ${companyOk ? '**conforme**' : '**DIVERGENTE**'}.`);
    if (!companyOk) ok = false;
    const revokedKept = byId.get(`rt-a2-${stamp}`)?.isRevoked === true && byId.get(`rt-a1-${stamp}`)?.isRevoked === false;
    lines.push(`- Estado de revogação preservado (a revogada continua revogada, a ativa continua ativa): ${revokedKept ? '**sim**' : '**NÃO**'}.`);
    if (!revokedKept) ok = false;
    const leak = (await sa([
      client.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM refresh_tokens rt WHERE rt::text LIKE '%legacy-%') + (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'refresh_tokens' AND column_name = 'token') AS n`),
    ]))[1] as Array<{ n: number }>;
    lines.push(`- Segredo em texto: coluna \`token\` removida e nenhum valor "legacy-…" restou em nenhuma coluna → ${leak[0].n === 0 ? '**ausente**' : '**AINDA PRESENTE**'}.`);
    if (leak[0].n !== 0) ok = false;
  } finally {
    await client.$disconnect();
    try {
      await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
      await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
      lines.push('- Banco temporário 3 removido: sim.');
    } catch (e) {
      lines.push(`- **Banco temporário 3 NÃO removido** (${e instanceof Error ? e.message.split('\n').pop() : 'erro'}): \`DROP DATABASE "${name}"\` manual.`);
      ok = false;
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    } catch {
      lines.push(`- Pasta temporária \`${tmp}\` não pôde ser removida agora (arquivo em uso).`);
    }
  }
  return { ok, lines };
}

/**
 * CENÁRIO DE FILIAL/EMPRESA (quarto banco temporário): estado ANTES da migration `20261015100000_company_and_branch_fks`, com (a) um produto da empresa A
 * gravado com a filial da empresa B (aceito pelo schema antigo, que não tinha FK de filial) e (b) um cliente de empresa INEXISTENTE (órfão legado).
 * Esperado: o deploy ABORTA por causa de (a) sem aplicar nada (atomicidade); depois de corrigir (a), o roteiro de recuperação conclui e (b) é
 * PRESERVADO — sem associar a empresa alguma — com a FK de empresa daquela tabela deixada NOT VALID (sinal explícito do legado).
 */
const BRANCH_MIGRATION = '20261015100000_company_and_branch_fks';

async function branchScenario(devUrl: string, admin: PrismaClient): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const devName = new URL(devUrl).pathname.replace(/^\//, '');
  const name = `${devName}_replay4_tmp`;
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`nome inválido: ${name}`);
  const exists = (await admin.$queryRawUnsafe(`SELECT 1 AS x FROM pg_database WHERE datname = '${name}'`)) as unknown[];
  if (exists.length) throw new Error(`o banco temporário "${name}" já existe — recusado.`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const url = withDatabase(devUrl, name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mig-'));
  let ok = true;
  const client = new PrismaClient({ datasources: { db: { url } } });
  const prismaCli = path.join(REPO, 'node_modules', 'prisma', 'build', 'index.js');
  try {
    fs.mkdirSync(path.join(tmp, 'prisma', 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(DB_PKG, 'prisma', 'schema.prisma'), path.join(tmp, 'prisma', 'schema.prisma'));
    fs.copyFileSync(path.join(DB_PKG, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tmp, 'prisma', 'migrations', 'migration_lock.toml'));
    const all = fs.readdirSync(path.join(DB_PKG, 'prisma', 'migrations')).filter((d) => fs.statSync(path.join(DB_PKG, 'prisma', 'migrations', d)).isDirectory()).sort();
    const before = all.filter((d) => d < BRANCH_MIGRATION);
    for (const d of before) fs.cpSync(path.join(DB_PKG, 'prisma', 'migrations', d), path.join(tmp, 'prisma', 'migrations', d), { recursive: true });
    const partial = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: tmp, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
    lines.push(`- Banco temporário 4: ${before.length} migrations aplicadas (até a anterior à de FKs de empresa/filial): ${partial.status === 0 ? 'sucesso' : '**FALHOU**'}.`);
    if (partial.status !== 0) return { ok: false, lines };

    const sa = (ops: any[]) =>
      client.$transaction([
        contextStatement(client, PLATFORM_CONTEXT),
        ...ops,
      ]);
    const stamp = Date.now();
    const mkCompany = async (n: string, doc: string) =>
      (await sa([client.company.create({ data: { name: `Teste filial ${n}`, document: doc, email: `fil-${n}-${stamp}@teste.local`, isActive: true } })]))[1] as { id: string };
    const A = await mkCompany('A', String(stamp).slice(-8).padStart(14, '5'));
    const B = await mkCompany('B', String(stamp + 1).slice(-8).padStart(14, '6'));
    const mkBranch = async (companyId: string, n: string) => (await sa([client.branch.create({ data: { companyId, name: `Filial ${n}`, isActive: true } })]))[1] as { id: string };
    const bA = await mkBranch(A.id, 'A');
    const bB = await mkBranch(B.id, 'B');
    const cross = (await sa([client.product.create({ data: { companyId: A.id, branchId: bB.id, sku: `FIL-${stamp}`, name: 'cruzado', costPrice: 1, salePrice: 2, isActive: true } })]))[1] as { id: string };
    const ghost = crypto.randomUUID();
    await sa([client.customer.create({ data: { companyId: ghost, name: `Orfao ${stamp}` } })]);
    lines.push('- Dados sintéticos: **1 produto da empresa A gravado com a filial da empresa B** e **1 cliente de empresa inexistente** (os dois aceitos pelo schema antigo, sem FK).');

    const full1 = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    const aborted = full1.status !== 0 && /company_and_branch_fks/.test(`${full1.stdout}${full1.stderr}`);
    lines.push(`- \`migrate deploy\` com filial de outra empresa: ${aborted ? '**abortou como esperado** (a guarda recusou o dado cruzado e listou a tabela)' : '**NÃO abortou — inesperado**'}.`);
    if (!aborted) ok = false;
    const st = (await client.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM pg_constraint WHERE conname = 'products_companyId_branchId_fkey') AS branch_fk, (SELECT count(*)::int FROM pg_constraint WHERE conname = 'customers_companyId_fkey') AS company_fk`
    )) as Array<{ branch_fk: number; company_fk: number }>;
    const atomic = st[0].branch_fk === 0 && st[0].company_fk === 0;
    lines.push(`- Atomicidade: depois do aborto, FK de filial ${st[0].branch_fk}, FK de empresa ${st[0].company_fk} → ${atomic ? '**nada ficou aplicado pela metade**' : '**ESTADO PARCIAL — investigar**'}.`);
    if (!atomic) ok = false;

    // recuperação: a filial CERTA vem da própria empresa do produto (aqui, a filial A, escolhida pelo operador; o script nunca "adivinha")
    await sa([client.product.updateMany({ where: { id: cross.id, companyId: A.id }, data: { branchId: bA.id } })]);
    const resolve = spawnSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', BRANCH_MIGRATION], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    const full2 = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: DB_PKG, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: 'utf8' });
    lines.push(`- Recuperação (corrigir a filial do produto → \`migrate resolve --rolled-back\` → \`migrate deploy\`): ${resolve.status === 0 && full2.status === 0 ? '**concluiu**' : '**FALHOU**'}.`);
    if (resolve.status !== 0 || full2.status !== 0) {
      ok = false;
      return { ok, lines };
    }

    const fin = (await sa([
      client.$queryRawUnsafe(
        `SELECT (SELECT convalidated FROM pg_constraint WHERE conname = 'products_companyId_branchId_fkey') AS branch_valid,
                (SELECT convalidated FROM pg_constraint WHERE conname = 'customers_companyId_fkey') AS company_valid,
                (SELECT count(*)::int FROM customers WHERE name = 'Orfao ${stamp}') AS orphan_kept`
      ),
    ]))[1] as Array<{ branch_valid: boolean; company_valid: boolean; orphan_kept: number }>;
    const r = fin[0];
    const preserved = r.branch_valid === true && r.company_valid === false && r.orphan_kept === 1;
    lines.push(
      `- Resultado: FK de filial validada = ${r.branch_valid}; FK de empresa de \`customers\` validada = ${r.company_valid} (deve ser **false**: existe o cliente órfão); cliente órfão preservado = ${r.orphan_kept} → ${preserved ? '**o legado fica visível (NOT VALID) e nada foi apagado nem associado a empresa por suposição**' : '**DIVERGENTE**'}.`
    );
    if (!preserved) ok = false;
    // linha NOVA com empresa inexistente continua recusada mesmo com a FK NOT VALID
    let rejected = false;
    try {
      await sa([client.customer.create({ data: { companyId: crypto.randomUUID(), name: `Orfao novo ${stamp}` } })]);
    } catch (e: any) {
      rejected = e?.code === 'P2003';
    }
    lines.push(`- Linha NOVA com empresa inexistente: ${rejected ? '**recusada (P2003)** — NOT VALID protege tudo que entra daqui em diante' : '**ACEITA — inesperado**'}.`);
    if (!rejected) ok = false;
  } finally {
    await client.$disconnect();
    try {
      await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
      await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
      lines.push('- Banco temporário 4 removido: sim.');
    } catch (e) {
      lines.push(`- **Banco temporário 4 NÃO removido** (${e instanceof Error ? e.message.split('\n').pop() : 'erro'}): \`DROP DATABASE "${name}"\` manual.`);
      ok = false;
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    } catch {
      lines.push(`- Pasta temporária \`${tmp}\` não pôde ser removida agora (arquivo em uso).`);
    }
  }
  return { ok, lines };
}

async function main() {
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl) throw new Error('DATABASE_URL ausente (apps/api/.env).');
  const devName = new URL(devUrl).pathname.replace(/^\//, '');
  const name = `${devName}_replay_tmp`;
  if (!/^[A-Za-z0-9_]+$/.test(name) || !name.endsWith('_replay_tmp') || name === devName) throw new Error(`nome de banco temporário inválido: ${name}`);
  const scratchUrl = withDatabase(devUrl, name);
  const admin = new PrismaClient({ datasources: { db: { url: withDatabase(devUrl, 'postgres') } } });

  const exists = (await admin.$queryRawUnsafe(`SELECT 1 AS x FROM pg_database WHERE datname = '${name}'`)) as unknown[];
  if (exists.length) { await admin.$disconnect(); throw new Error(`o banco temporário "${name}" já existe — recusado (não apago o que não criei).`); }
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);

  const lines: string[] = [];
  let ok = true;
  let dropped = false;
  try {
    const deploy = prisma(['migrate', 'deploy'], scratchUrl);
    const found = (deploy.stdout.match(/(\d+) migrations? found/i) ?? [])[1];
    lines.push(`- \`prisma migrate deploy\` em banco vazio: ${deploy.status === 0 ? 'sucesso' : '**FALHOU**'} (${found ?? '?'} migrations encontradas em \`prisma/migrations\`).`);
    if (deploy.status !== 0) { ok = false; lines.push('```\n' + (deploy.stderr || deploy.stdout).split('\n').slice(-15).join('\n') + '\n```'); }

    if (deploy.status === 0) {
      // schema Prisma × banco reaplicado (o que o Prisma enxerga)
      const diffArgs = ['migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'];
      const diffReplay = prisma(diffArgs, scratchUrl);
      const diffDev = prisma(diffArgs, devUrl);
      const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'drift-dev.txt'), norm(diffDev.stdout) + '\n', 'utf8');
      const same = norm(diffReplay.stdout) === norm(diffDev.stdout);
      const stmts = (s: string) => norm(s).split('\n').filter((l) => l.trim() && !l.startsWith('--')).length;
      const empty = stmts(diffReplay.stdout) === 0 && stmts(diffDev.stdout) === 0;
      lines.push(
        `- \`prisma migrate diff\` (banco → schema.prisma): banco reaplicado do zero e banco de desenvolvimento produzem ${same ? '**exatamente a mesma saída**' : '**saídas DIFERENTES**'}` +
          (empty ? ' — **vazia (0 instruções): o `schema.prisma` descreve exatamente o banco**.' : ` (${stmts(diffReplay.stdout)} instruções que o schema não representa — ver drift-dev.txt).`)
      );
      if (!same) ok = false;

      // catálogo completo: dev × reaplicado
      const a = await signature(devUrl);
      const b = await signature(scratchUrl);
      const setA = new Set(a.lines);
      const setB = new Set(b.lines);
      const onlyDev = a.lines.filter((l) => !setB.has(l));
      const onlyReplay = b.lines.filter((l) => !setA.has(l));
      lines.push(`- Catálogo completo (colunas, índices, constraints, policies, RLS, triggers, funções, sequências, enums): dev = ${a.lines.length} itens, reaplicado = ${b.lines.length} itens; **só no dev: ${onlyDev.length}**; **só no reaplicado: ${onlyReplay.length}**.`);
      if (onlyDev.length || onlyReplay.length) {
        ok = false;
        lines.push('```');
        for (const l of onlyDev.slice(0, 40)) lines.push(`só no dev: ${l.slice(0, 220)}`);
        for (const l of onlyReplay.slice(0, 40)) lines.push(`só no reaplicado: ${l.slice(0, 220)}`);
        lines.push('```');
      }
      lines.push(`- PostgreSQL: ${b.version}.`);
      lines.push(`- FKs NOT VALID (legado de dado, normalizadas na comparação acima): dev = ${a.notValid.length}${a.notValid.length ? ' (' + a.notValid.join(', ') + ')' : ''}; reaplicado do zero = ${b.notValid.length}.`);

      // RLS no banco reaplicado
      const rls = spawnSync('npx', ['tsx', 'scripts/check-rls.ts'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: scratchUrl, CHECK_RLS_ALLOW_LEGACY: 'true' }, shell: true, encoding: 'utf8' });
      const tail = (rls.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
      lines.push(`- \`db:check-rls\` no banco reaplicado: ${rls.status === 0 ? 'todas as invariantes OK' : '**FALHOU**'} — ${tail}`);
      if (rls.status !== 0) ok = false;
    }
  } finally {
    try {
      await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
      await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
      dropped = true;
    } catch (e) {
      lines.push(`- **Banco temporário NÃO removido** (${e instanceof Error ? e.message.split('\n').pop() : 'erro'}): remover manualmente \`DROP DATABASE "${name}"\`.`);
    }
  }
  let scenario: { ok: boolean; lines: string[] } = { ok: false, lines: ['- Cenário com dados: não executado.'] };
  try {
    scenario = await dataScenario(devUrl, admin);
  } catch (e) {
    scenario = { ok: false, lines: [`- Cenário com dados **FALHOU**: ${e instanceof Error ? e.message.split('\n')[0] : 'erro'}`] };
  }
  if (!scenario.ok) ok = false;
  let scenario2: { ok: boolean; lines: string[] } = { ok: false, lines: ['- Cenário de sessões: não executado.'] };
  try {
    scenario2 = await refreshScenario(devUrl, admin);
  } catch (e) {
    scenario2 = { ok: false, lines: [`- Cenário de sessões **FALHOU**: ${e instanceof Error ? e.message.split('\n').filter((l) => l.trim()).slice(-2).join(' | ').slice(0, 300) : 'erro'}`] };
  }
  if (!scenario2.ok) ok = false;
  let scenario3: { ok: boolean; lines: string[] } = { ok: false, lines: ['- Cenário de filial/empresa: não executado.'] };
  try {
    scenario3 = await branchScenario(devUrl, admin);
  } catch (e) {
    scenario3 = { ok: false, lines: [`- Cenário de filial/empresa **FALHOU**: ${e instanceof Error ? e.message.split('\n')[0] : 'erro'}`] };
  }
  if (!scenario3.ok) ok = false;
  await admin.$disconnect();
  const date = new Date().toISOString().slice(0, 10);
  const md = [
    `**Execução de ${date}** (\`npm run db:replay-check\`) — banco temporário vazio, criado e removido pelo script; o banco de desenvolvimento só foi lido. Resultado: **${ok ? 'IDÊNTICO — nada no banco de desenvolvimento escapa das migrations' : 'COM DIFERENÇAS (ver abaixo)'}**.`,
    '',
    ...lines,
    `- Banco temporário removido: ${dropped ? 'sim' : '**não**'}.`,
    '',
    '**Cenário com dados inconsistentes (migration das FKs compostas):**',
    '',
    ...scenario.lines,
    '',
    '**Cenário de sessões (migration de refresh_tokens: hash, empresa e RLS):**',
    '',
    ...scenario2.lines,
    '',
    '**Cenário de filial/empresa (migration das FKs de empresa e filial: guarda, atomicidade, legado preservado):**',
    '',
    ...scenario3.lines,
    '',
  ].join('\n');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'replay-resultado.md'), md, 'utf8');
  console.log(md);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[erro] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
