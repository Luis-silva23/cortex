/**
 * Publica na Central de Ajuda (base de conhecimento do Suporte) os artigos operacionais de docs/ajuda/CENTRAL_DE_AJUDA.md.
 * Idempotente: o endereço (slug) identifica o artigo; rodar de novo só atualiza o que mudou. Não apaga artigo nenhum.
 *
 *   npm run help:seed                                  # simulação: mostra o que criaria/atualizaria
 *   npm run help:seed -- --apply                       # grava como RASCUNHO
 *   npm run help:seed -- --apply --publish             # grava e PUBLICA
 *   opções: --author-numeric-id <id>  (Super Admin autor; padrão: o primeiro Super Admin ativo)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const FILE = path.resolve(__dirname, '../../../docs/ajuda/CENTRAL_DE_AJUDA.md');
const CATEGORY_NAME = 'Operação da loja';
const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Article {
  slug: string;
  modulo: string | null;
  titulo: string;
  resumo: string | null;
  palavras: string | null;
  body: string;
}

/**
 * O visualizador da Central de Ajuda mostra TEXTO PURO (sem renderizar Markdown, de propósito: nada de HTML vindo de conteúdo).
 * Os artigos são escritos em Markdown leve só para facilitar a revisão; aqui viram texto limpo: títulos em linha própria,
 * sem `**`, `*`, crases nem sintaxe de tabela (cada linha da tabela vira "- coluna 1: coluna 2 → coluna 3").
 */
export function toPlainText(markdown: string): string {
  const out: string[] = [];
  let tableHeaderSkipped = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (/^\|\s*-+/.test(line)) continue; // separador de tabela
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!tableHeaderSkipped) {
        tableHeaderSkipped = true; // cabeçalho
        continue;
      }
      out.push(`- ${cells[0]}${cells.length > 1 ? `: ${cells[1]}` : ''}${cells.length > 2 ? ` → ${cells[2]}` : ''}`);
      continue;
    }
    tableHeaderSkipped = false;
    if (/^#{1,6}\s+/.test(line)) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(line.replace(/^#{1,6}\s+/, ''));
      continue;
    }
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseArticles(markdown: string): Article[] {
  const out: Article[] = [];
  const re = /<!--\s*artigo:\s*([^>]*?)\s*-->([\s\S]*?)<!--\s*\/artigo\s*-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const fields: Record<string, string> = {};
    for (const part of m[1].split('|')) {
      const [k, ...v] = part.split('=');
      if (k && v.length) fields[k.trim()] = v.join('=').trim();
    }
    if (!fields.slug || !fields.titulo) throw new Error(`Artigo sem slug/titulo: ${m[1].slice(0, 80)}`);
    out.push({
      slug: fields.slug,
      modulo: fields.modulo || null,
      titulo: fields.titulo,
      resumo: fields.resumo || null,
      palavras: fields.palavras || null,
      body: toPlainText(m[2].trim()),
    });
  }
  return out;
}

async function main() {
  const articles = parseArticles(fs.readFileSync(FILE, 'utf8'));
  const apply = flag('apply');
  const publish = flag('publish');
  console.log(`[help] ${articles.length} artigos em ${path.relative(process.cwd(), FILE)} · modo: ${apply ? (publish ? 'APLICAR + PUBLICAR' : 'APLICAR (rascunho)') : 'SIMULAÇÃO'}`);

  const { prisma, runWithRLSContext } = await import('@ln-system/database');
  const { supportKbService } = await import('../src/services/support-kb.service');

  await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
    const wanted = arg('author-numeric-id');
    const author = await prisma.user.findFirst({
      where: { userType: 'SUPER_ADMIN', isActive: true, ...(wanted ? { numericId: Number(wanted) } : {}) },
      orderBy: { numericId: 'asc' },
      select: { id: true, name: true },
    });
    if (!author) throw new Error('Nenhum Super Admin ativo encontrado para ser o autor dos artigos.');

    let category = await prisma.supportKbCategory.findFirst({ where: { name: CATEGORY_NAME }, select: { id: true } });
    if (!category) {
      console.log(`[help] categoria "${CATEGORY_NAME}" ${apply ? 'criada' : 'seria criada'}`);
      if (apply) category = (await supportKbService.createCategory({ name: CATEGORY_NAME, sortOrder: 10 })) as any;
    }

    for (const a of articles) {
      const existing = await prisma.supportKbArticle.findUnique({ where: { slug: a.slug }, select: { id: true, body: true, title: true, summary: true, status: true } });
      const input = { title: a.titulo, summary: a.resumo, body: a.body, keywords: a.palavras, module: a.modulo, categoryId: category?.id ?? 'SIMULACAO', slug: a.slug };
      if (!existing) {
        console.log(`[help] + ${a.slug} (novo)`);
        if (apply) {
          const created = await supportKbService.create(author, input);
          if (publish) await supportKbService.setStatus(created.id, 'PUBLISHED');
        }
      } else if (existing.body !== a.body || existing.title !== a.titulo || existing.summary !== a.resumo) {
        console.log(`[help] ~ ${a.slug} (atualizado)`);
        if (apply) {
          const { slug: _slug, ...patch } = input;
          await supportKbService.update(existing.id, patch);
          if (publish && existing.status !== 'PUBLISHED') await supportKbService.setStatus(existing.id, 'PUBLISHED');
        }
      } else {
        console.log(`[help] = ${a.slug} (sem mudança)`);
        if (apply && publish && existing.status !== 'PUBLISHED') await supportKbService.setStatus(existing.id, 'PUBLISHED');
      }
    }
  });
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`[erro] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => process.exit());
}
