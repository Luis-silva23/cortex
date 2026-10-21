import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

/**
 * OBJETOS DO BANCO QUE O PRISMA NÃO REPRESENTA BEM — numeração dos chamados e busca textual da base de conhecimento (Postgres real).
 * O `prisma migrate diff` do banco para o schema.prisma antigo propunha `DROP SEQUENCE support_ticket_number_seq` (e tirar o DEFAULT de
 * `ticketNumber`) e `DROP INDEX support_kb_articles_search_idx`. Isso NUNCA esteve em migration — era a saída do diff —, mas aplicá-la
 * deixaria chamados novos sem número e a busca sem índice. O schema agora descreve esses objetos e o diff é vazio; este teste prova que o
 * banco REAL continua com o que a aplicação precisa.
 */
describe('Chamados: numeração por sequência; base de conhecimento: coluna gerada e índice GIN (integração real)', () => {
  let F: IntegrationFixture;
  const stamp = Date.now();
  let categoryId: string;
  let articleId: string;

  beforeAll(async () => {
    F = await createFixture('suppschema');
  });

  afterAll(async () => {
    if (articleId) await bypass(() => db.supportKbArticle.deleteMany({ where: { id: articleId } }));
    if (categoryId) await bypass(() => db.supportKbCategory.deleteMany({ where: { id: categoryId } }));
    if (F) await destroyFixture(F); // purga também os chamados da fixture
  });

  const newTicket = (i: number) =>
    runWithRLSContext({ companyId: F.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
      prisma.supportTicket.create({
        data: { companyId: F.companyId, requesterId: F.userId, requesterName: 'Teste', requesterRole: 'COMPANY_ADMIN', subject: `Numeração ${stamp}-${i}`, module: 'GERAL', type: 'DUVIDA', description: 'Chamado sintético do teste de numeração.' },
      })
    );

  it('estrutura: ticketNumber é NOT NULL com DEFAULT nextval(sequência), a sequência existe e pertence à coluna', async () => {
    const r = await bypass<any[]>(() =>
      db.$queryRawUnsafe(`
        SELECT a.attnotnull AS not_null,
               pg_get_expr(d.adbin, d.adrelid) AS def,
               (SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relname = 'support_ticket_number_seq') AS seq_exists,
               (SELECT count(*)::int FROM pg_depend dp WHERE dp.objid = 'support_ticket_number_seq'::regclass AND dp.refobjid = 'support_tickets'::regclass AND dp.deptype = 'a') AS owned
          FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = 'support_tickets'::regclass AND a.attname = 'ticketNumber'`)
    );
    expect(r).toHaveLength(1);
    expect(r[0].not_null).toBe(true);
    expect(r[0].def).toContain("nextval('support_ticket_number_seq'::regclass)");
    expect(r[0].seq_exists).toBe(1);
    expect(r[0].owned).toBe(1);
  });

  it('12 chamados criados em paralelo recebem 12 números DISTINTOS, positivos, sem colisão — e acima de qualquer número já existente', async () => {
    const before = await bypass<any[]>(() => db.$queryRawUnsafe(`SELECT coalesce(max("ticketNumber"), 0)::int AS m FROM support_tickets`));
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => newTicket(i)));
    const numbers = created.map((t) => t.ticketNumber);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    expect(Math.min(...numbers)).toBeGreaterThan(before[0].m);
    const seq = await bypass<any[]>(() => db.$queryRawUnsafe(`SELECT last_value::int AS v FROM support_ticket_number_seq`));
    expect(seq[0].v).toBeGreaterThanOrEqual(Math.max(...numbers));
  });

  it('o número é único no banco (índice único) — repetir um número existente é recusado', async () => {
    const t = await newTicket(99);
    await expect(
      bypass(() =>
        db.supportTicket.create({
          data: { ticketNumber: t.ticketNumber, companyId: F.companyId, requesterId: F.userId, requesterName: 'x', requesterRole: 'COMPANY_ADMIN', subject: 'dup', module: 'GERAL', type: 'DUVIDA', description: 'dup' },
        })
      )
    ).rejects.toThrow(/Unique constraint|duplicate key|unique/i);
  });

  it('base de conhecimento: `search` é coluna GERADA, o índice GIN existe e a busca acompanha título e corpo', async () => {
    const meta = await bypass<any[]>(() =>
      db.$queryRawUnsafe(`
        SELECT a.attgenerated::text AS gen,
               (SELECT indexdef FROM pg_indexes WHERE indexname = 'support_kb_articles_search_idx') AS idx
          FROM pg_attribute a WHERE a.attrelid = 'support_kb_articles'::regclass AND a.attname = 'search'`)
    );
    expect(meta[0].gen).toBe('s'); // STORED
    expect(meta[0].idx).toMatch(/USING gin \(search\)/);

    const cat = await bypass<any>(() => db.supportKbCategory.create({ data: { slug: `cat-${stamp}`, name: 'Categoria sintética' } }));
    categoryId = cat.id;
    const art = await bypass<any>(() =>
      db.supportKbArticle.create({
        data: { categoryId, slug: `art-${stamp}`, title: `Zorbulador ${stamp}`, summary: 'resumo', body: 'Como configurar o zorbulador de teste', keywords: 'xyzzy', status: 'PUBLISHED', authorId: F.userId, authorName: 'Teste' },
      })
    );
    articleId = art.id;
    // a coluna foi preenchida pelo banco, sem a aplicação escrever nela
    const found = await bypass<any[]>(() => db.$queryRawUnsafe(`SELECT id FROM support_kb_articles WHERE search @@ websearch_to_tsquery('portuguese', 'zorbulador') AND id = '${articleId}'`));
    expect(found).toHaveLength(1);
    // atualizar o título atualiza a busca (coluna gerada acompanha)
    await bypass(() => db.supportKbArticle.update({ where: { id: articleId }, data: { title: `Quibblesnork ${stamp}`, body: 'sem a palavra antiga' } }));
    expect(await bypass<any[]>(() => db.$queryRawUnsafe(`SELECT id FROM support_kb_articles WHERE search @@ websearch_to_tsquery('portuguese', 'zorbulador') AND id = '${articleId}'`))).toHaveLength(0);
    expect(await bypass<any[]>(() => db.$queryRawUnsafe(`SELECT id FROM support_kb_articles WHERE search @@ websearch_to_tsquery('portuguese', 'quibblesnork') AND id = '${articleId}'`))).toHaveLength(1);
  });

  it('índice GIN válido; e a base de conhecimento é pequena o bastante para a varredura que o papel da aplicação faz', async () => {
    const r = await bypass<any[]>(() =>
      db.$queryRawUnsafe(`
        SELECT i.indisvalid AS valid, i.indisready AS ready, am.amname AS method,
               (SELECT count(*)::int FROM support_kb_articles) AS articles
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
         WHERE c.relname = 'support_kb_articles_search_idx'`)
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ valid: true, ready: true, method: 'gin' });
    // ACHADO DE PLANO (EXPLAIN em REVISAO_BANCO_PENDENCIAS): com o papel da aplicação a RLS acrescenta ao filtro uma condição que usa
    // `is_super_admin()` (não é "leakproof") e o operador `@@` também não é; o planejador então NÃO usa o índice GIN para esse papel, mesmo
    // com `enable_seqscan = off` — faz varredura sequencial com filtro. Com a base de conhecimento global pequena isso é irrelevante. Este
    // limite avisa quando a premissa deixar de valer (reavaliar: função SECURITY DEFINER de busca ou policy sem função).
    expect(r[0].articles).toBeLessThan(2000);
  });
});
