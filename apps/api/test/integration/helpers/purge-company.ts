import { runInTransaction, runWithRLSContext } from '@ln-system/database';

/**
 * Expurgo de TODOS os dados de uma empresa SINTÉTICA, guiado pelo catálogo do PostgreSQL (não por uma lista escrita à mão).
 *
 * Por quê: com as FKs compostas/RESTRICT (2026-10-14, `20261014180000_composite_company_fks`) a ordem de remoção das tabelas
 * de teste passou a importar em dezenas de pontos; uma lista manual envelhece a cada tabela nova. Aqui a ordem vem das
 * próprias FKs (filhos antes dos pais) e o que sobrar por ciclo/dependência é repetido com SAVEPOINT até convergir —
 * se NÃO convergir, falha com a mensagem do banco (nunca ignora um RESTRICT).
 *
 * Alcance: tabela com coluna `companyId` → `WHERE "companyId" = $1`; tabela sem ela → pelo caminho de FK até uma tabela
 * escopada (`"fk" IN (SELECT id FROM pai WHERE …)`). A linha de `companies` NÃO é apagada aqui (quem chama decide).
 * Roda como SUPER_ADMIN com `app.audit_purge = on` (as tabelas append-only só aceitam DELETE com essa sinalização,
 * na mesma transação). Chamar SÓ depois de `assertDestroyable(companyId)`.
 */

interface TablePlan {
  table: string;
  where: (param: string) => string;
}

let cachedPlan: TablePlan[] | null = null;

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function buildPlan(tx: any): Promise<TablePlan[]> {
  const tables: Array<{ t: string }> = await tx.$queryRawUnsafe(
    `select c.relname as t from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> '_prisma_migrations'`
  );
  const scoped: Array<{ t: string; typ: string }> = await tx.$queryRawUnsafe(
    `select table_name as t, data_type as typ from information_schema.columns where table_schema = 'public' and column_name = 'companyId'`
  );
  const fks: Array<{ child: string; parent: string; col: string; pcol: string }> = await tx.$queryRawUnsafe(
    `select cc.relname as child, pc.relname as parent, ca.attname as col, pa.attname as pcol
       from pg_constraint k
       join pg_class cc on cc.oid = k.conrelid
       join pg_class pc on pc.oid = k.confrelid
       join pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = k.conkey[1]
       join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = k.confkey[1]
      where k.contype = 'f' and cardinality(k.conkey) = 1 and cc.relnamespace = 'public'::regnamespace`
  );

  const names = tables.map((r) => r.t).filter((t) => t !== 'companies');
  const scopedType = new Map(scoped.map((r) => [r.t, r.typ]));
  const preds = new Map<string, (p: string) => string>();
  for (const t of names) {
    if (scopedType.has(t)) {
      const cast = scopedType.get(t) === 'uuid' ? '::uuid' : '';
      preds.set(t, (p) => `${q('companyId')} = ${p}${cast}`);
    }
  }
  // tabelas sem companyId: escopo pelo pai (iterado até estabilizar; profundidade pequena)
  for (let i = 0; i < 6; i++) {
    for (const t of names) {
      if (preds.has(t)) continue;
      // TODAS as FKs para pais já escopados, em OR: a linha é da empresa se QUALQUER pai for (FKs válidas ⇒ todos os pais são da mesma
      // empresa). Escolher só a primeira perderia linhas cujo pai escolhido é opcional (ex.: item de OS de serviço, sem produto).
      const via = fks.filter((f) => f.child === t && f.parent !== t && preds.has(f.parent));
      if (via.length) {
        preds.set(t, (p) => via.map((fk) => `${q(fk.col)} IN (SELECT ${q(fk.pcol)} FROM ${q(fk.parent)} WHERE ${preds.get(fk.parent)!(p)})`).join(' OR '));
      }
    }
  }

  // ordem: filhos antes dos pais (Kahn sobre as FKs entre tabelas com escopo); ciclos viram sobra tratada nas passadas
  const inScope = names.filter((t) => preds.has(t));
  const waiting = new Map<string, number>(inScope.map((t) => [t, 0]));
  const seen = new Set<string>();
  for (const f of fks) {
    const key = `${f.child}>${f.parent}`;
    if (f.child === f.parent || !waiting.has(f.child) || !waiting.has(f.parent) || seen.has(key)) continue;
    seen.add(key);
    waiting.set(f.parent, (waiting.get(f.parent) ?? 0) + 1); // o pai espera cada filho distinto sair
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  const ready = inScope.filter((t) => (waiting.get(t) ?? 0) === 0);
  const edges = Array.from(seen).map((k) => k.split('>') as [string, string]);
  while (ready.length) {
    const t = ready.shift()!;
    if (done.has(t)) continue;
    done.add(t);
    ordered.push(t);
    for (const [child, parent] of edges) {
      if (child !== t) continue;
      waiting.set(parent, (waiting.get(parent) ?? 1) - 1);
      if ((waiting.get(parent) ?? 0) <= 0 && !done.has(parent)) ready.push(parent);
    }
  }
  for (const t of inScope) if (!done.has(t)) ordered.push(t);
  return ordered.map((t) => ({ table: t, where: preds.get(t)! }));
}

/** Apaga os dados da empresa em todas as tabelas (menos a própria linha de `companies`). */
export async function purgeCompanyData(companyId: string): Promise<void> {
  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    await runInTransaction(
      async (tx: any) => {
        if (!cachedPlan) cachedPlan = await buildPlan(tx);
        await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
        let todo = cachedPlan;
        for (let pass = 0; pass < 8 && todo.length; pass++) {
          const failed: Array<{ plan: TablePlan; message: string }> = [];
          for (const plan of todo) {
            await tx.$executeRawUnsafe('SAVEPOINT purge_step');
            try {
              await tx.$executeRawUnsafe(`DELETE FROM ${q(plan.table)} WHERE ${plan.where('$1')}`, companyId);
              await tx.$executeRawUnsafe('RELEASE SAVEPOINT purge_step');
            } catch (err: any) {
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT purge_step');
              failed.push({ plan, message: String(err?.message ?? err) });
            }
          }
          if (failed.length && (failed.length === todo.length || pass === 7)) {
            const detail = failed
              .slice(0, 6)
              .map((f) => `${f.plan.table}: ${/Message: `([^`]*)`/.exec(f.message.replace(/\s+/g, ' '))?.[1] ?? f.message.replace(/\s+/g, ' ').slice(-200)}`)
              .join(' || ');
            throw new Error(`purgeCompanyData: não convergiu — ${detail}`);
          }
          todo = failed.map((f) => f.plan);
        }
      },
      { timeout: 60_000, maxWait: 30_000 }
    );
  });
}
