import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, runInTransaction } from '@ln-system/database';
import { AppError, ConflictError } from '@ln-system/shared';
import { SUPPORT_MODULES } from './support-catalog';

/**
 * Base de conhecimento (docs/CORTEX/SUPPORT.md): conteúdo do produto, global. A RLS garante que usuário de empresa só lê
 * artigo PUBLICADO e que só a plataforma (SUPER_ADMIN) cria/edita/publica. Pesquisa = full-text do Postgres
 * (dicionário português, coluna gerada + índice GIN) com reforço por trecho do título/palavras-chave. Sem IA.
 */
const bad = (message: string, code: string) => new AppError(message, 400, code);

export const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const articleSchema = z
  .object({
    title: z.string().trim().min(3, 'Título: mínimo 3 caracteres').max(160),
    summary: z.string().trim().max(300).nullish(),
    body: z.string().trim().min(10, 'Conteúdo: mínimo 10 caracteres').max(50_000),
    keywords: z.string().trim().max(300).nullish(),
    module: z.enum(Object.keys(SUPPORT_MODULES) as [string, ...string[]]).nullish(),
    categoryId: z.string().min(1, 'Escolha a categoria'),
    slug: z.string().trim().max(80).optional(),
  })
  .strict();

const categorySchema = z
  .object({
    name: z.string().trim().min(2, 'Nome: mínimo 2 caracteres').max(60),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw bad(r.error.issues[0]?.message ?? 'Dados inválidos', 'VALIDATION_ERROR');
  return r.data;
}

function uniqueOr409(e: unknown, message: string, code: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictError(message, code);
  throw e;
}

const articleView = (a: any) => ({
  id: a.id,
  slug: a.slug,
  title: a.title,
  summary: a.summary,
  body: a.body,
  keywords: a.keywords,
  module: a.module,
  moduleLabel: a.module ? SUPPORT_MODULES[a.module as keyof typeof SUPPORT_MODULES] ?? a.module : null,
  status: a.status,
  category: a.category ? { id: a.category.id, slug: a.category.slug, name: a.category.name } : undefined,
  author: { id: a.authorId, name: a.authorName },
  publishedAt: a.publishedAt,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

export class SupportKbService {
  async categories() {
    const [cats, counts] = await Promise.all([
      prisma.supportKbCategory.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.supportKbArticle.groupBy({ by: ['categoryId'], where: { status: 'PUBLISHED' }, _count: { _all: true } }),
    ]);
    const byId = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    return cats.map((c) => ({ id: c.id, slug: c.slug, name: c.name, articles: byId.get(c.id) ?? 0 }));
  }

  /** Pesquisa (ou lista da categoria). Sem termo: artigos da categoria/módulo por título. Limite ≤ 20. */
  async search(q: { q?: unknown; category?: unknown; module?: unknown; limit?: unknown }) {
    const term = String(q.q ?? '').trim().slice(0, 120);
    const category = q.category ? String(q.category) : null;
    const module = q.module && String(q.module) in SUPPORT_MODULES ? String(q.module) : null;
    const limit = Math.min(20, Math.max(1, Number.parseInt(String(q.limit ?? '10'), 10) || 10));
    const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const rows = await runInTransaction(
      (tx) => tx.$queryRaw<Array<{ id: string; slug: string; title: string; summary: string | null; module: string | null; categoryName: string; categorySlug: string; rank: number }>>`
        SELECT a.id, a.slug, a.title, a.summary, a.module, c.name AS "categoryName", c.slug AS "categorySlug",
               CASE WHEN ${term} = '' THEN 0
                    ELSE ts_rank(a.search, websearch_to_tsquery('portuguese', ${term}))
                         + CASE WHEN a.title ILIKE ${like} THEN 1 ELSE 0 END END AS rank
        FROM support_kb_articles a
        JOIN support_kb_categories c ON c.id = a."categoryId"
        WHERE a.status = 'PUBLISHED' AND c."isActive" = true
          AND (${category}::text IS NULL OR c.slug = ${category} OR c.id = ${category})
          AND (${module}::text IS NULL OR a.module = ${module})
          AND (${term} = '' OR a.search @@ websearch_to_tsquery('portuguese', ${term}) OR a.title ILIKE ${like} OR coalesce(a.keywords, '') ILIKE ${like})
        ORDER BY rank DESC, a.title ASC
        LIMIT ${limit}`
    );
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      summary: r.summary,
      module: r.module,
      moduleLabel: r.module ? SUPPORT_MODULES[r.module as keyof typeof SUPPORT_MODULES] ?? r.module : null,
      category: { slug: r.categorySlug, name: r.categoryName },
    }));
  }

  async getBySlug(slug: string) {
    const a = await prisma.supportKbArticle.findFirst({ where: { slug, status: 'PUBLISHED' }, include: { category: true } });
    if (!a) throw new AppError('Artigo não encontrado. Volte para a pesquisa e tente outro termo.', 404, 'KB_ARTICLE_NOT_FOUND');
    return articleView(a);
  }

  // ------------------------------------------------------------------------------------------ plataforma (SUPER_ADMIN)
  async adminList(q: { status?: unknown; category?: unknown; q?: unknown }) {
    const where: Prisma.SupportKbArticleWhereInput = {
      ...(q.status === 'DRAFT' || q.status === 'PUBLISHED' ? { status: String(q.status) } : {}),
      ...(q.category ? { categoryId: String(q.category) } : {}),
      ...(q.q ? { title: { contains: String(q.q), mode: 'insensitive' } } : {}),
    };
    const rows = await prisma.supportKbArticle.findMany({ where, include: { category: true }, orderBy: { updatedAt: 'desc' }, take: 200 });
    return rows.map(articleView);
  }

  async adminGet(id: string) {
    const a = await prisma.supportKbArticle.findFirst({ where: { id }, include: { category: true } });
    if (!a) throw new AppError('Artigo não encontrado.', 404, 'KB_ARTICLE_NOT_FOUND');
    return articleView(a);
  }

  private async assertCategory(categoryId: string) {
    const c = await prisma.supportKbCategory.findFirst({ where: { id: categoryId }, select: { id: true } });
    if (!c) throw bad('Categoria não encontrada.', 'KB_CATEGORY_NOT_FOUND');
  }

  async create(author: { id: string; name: string }, input: unknown) {
    const data = parse(articleSchema, input);
    await this.assertCategory(data.categoryId);
    const slug = slugify(data.slug || data.title);
    if (!slug) throw bad('Título sem letras ou números para montar o endereço do artigo.', 'VALIDATION_ERROR');
    try {
      const a = await prisma.supportKbArticle.create({
        data: {
          categoryId: data.categoryId,
          slug,
          title: data.title,
          summary: data.summary ?? null,
          body: data.body,
          keywords: data.keywords ?? null,
          module: data.module ?? null,
          status: 'DRAFT',
          authorId: author.id,
          authorName: author.name,
        },
        include: { category: true },
      });
      return articleView(a);
    } catch (e) {
      uniqueOr409(e, 'Já existe um artigo com este endereço. Mude o título ou o endereço.', 'KB_SLUG_TAKEN');
    }
  }

  async update(id: string, input: unknown) {
    const data = parse(articleSchema.partial(), input);
    const before = await prisma.supportKbArticle.findFirst({ where: { id } });
    if (!before) throw new AppError('Artigo não encontrado.', 404, 'KB_ARTICLE_NOT_FOUND');
    if (data.categoryId) await this.assertCategory(data.categoryId);
    try {
      const a = await prisma.supportKbArticle.update({
        where: { id },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.summary !== undefined ? { summary: data.summary ?? null } : {}),
          ...(data.body !== undefined ? { body: data.body } : {}),
          ...(data.keywords !== undefined ? { keywords: data.keywords ?? null } : {}),
          ...(data.module !== undefined ? { module: data.module ?? null } : {}),
          ...(data.categoryId ? { categoryId: data.categoryId } : {}),
          ...(data.slug ? { slug: slugify(data.slug) } : {}),
        },
        include: { category: true },
      });
      return { before: { title: before.title, status: before.status }, article: articleView(a) };
    } catch (e) {
      uniqueOr409(e, 'Já existe um artigo com este endereço.', 'KB_SLUG_TAKEN');
    }
  }

  async setStatus(id: string, status: unknown) {
    if (status !== 'PUBLISHED' && status !== 'DRAFT') throw bad('Situação inválida: use publicar ou despublicar.', 'VALIDATION_ERROR');
    const before = await prisma.supportKbArticle.findFirst({ where: { id }, select: { status: true, publishedAt: true } });
    if (!before) throw new AppError('Artigo não encontrado.', 404, 'KB_ARTICLE_NOT_FOUND');
    const a = await prisma.supportKbArticle.update({
      where: { id },
      data: { status, ...(status === 'PUBLISHED' && !before.publishedAt ? { publishedAt: new Date() } : {}) },
      include: { category: true },
    });
    return { statusFrom: before.status, article: articleView(a) };
  }

  async adminCategories() {
    const [cats, counts] = await Promise.all([
      prisma.supportKbCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.supportKbArticle.groupBy({ by: ['categoryId'], _count: { _all: true } }),
    ]);
    const byId = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    return cats.map((c) => ({ id: c.id, slug: c.slug, name: c.name, sortOrder: c.sortOrder, isActive: c.isActive, articles: byId.get(c.id) ?? 0 }));
  }

  async createCategory(input: unknown) {
    const data = parse(categorySchema, input);
    const slug = slugify(data.name);
    try {
      return await prisma.supportKbCategory.create({ data: { name: data.name, slug, sortOrder: data.sortOrder ?? 0, isActive: data.isActive ?? true } });
    } catch (e) {
      uniqueOr409(e, 'Já existe uma categoria com este nome.', 'KB_CATEGORY_TAKEN');
    }
  }

  async updateCategory(id: string, input: unknown) {
    const data = parse(categorySchema.partial(), input);
    const before = await prisma.supportKbCategory.findFirst({ where: { id } });
    if (!before) throw new AppError('Categoria não encontrada.', 404, 'KB_CATEGORY_NOT_FOUND');
    try {
      const c = await prisma.supportKbCategory.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
      });
      return { before, category: c };
    } catch (e) {
      uniqueOr409(e, 'Já existe uma categoria com este nome.', 'KB_CATEGORY_TAKEN');
    }
  }
}

export const supportKbService = new SupportKbService();
