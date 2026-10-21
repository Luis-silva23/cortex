'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, BookOpen, LifeBuoy, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { HelpTabs } from '@/components/support/HelpTabs';
import { getApiErrorMessage } from '@/lib/errors';
import { supportApi, type KbArticleSummary } from '@/lib/api/support';
import { NEW_TICKET_PATH } from '@/lib/support';

type Category = { id: string; slug: string; name: string; articles: number };

/**
 * Ajuda e Suporte — pesquisa na base de conhecimento (full-text do Postgres em português; sem IA, sem chatbot) e
 * navegação por categoria. Só artigos PUBLICADOS aparecem (a RLS garante; rascunho é da equipe CÓRTEX).
 */
export default function HelpHomePage() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [results, setResults] = useState<KbArticleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supportApi
      .categories()
      .then((c) => setCategories(c.filter((x) => x.articles > 0)))
      .catch((err) => setError(getApiErrorMessage(err, 'Não foi possível carregar as categorias de ajuda.')));
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term && !category) {
      setResults([]);
      return undefined;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        setResults(await supportApi.searchArticles({ ...(term ? { q: term } : {}), ...(category ? { category: category.slug } : {}), limit: 20 }));
      } catch (err) {
        setError(getApiErrorMessage(err, 'Não foi possível pesquisar agora. Tente novamente.'));
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, category]);

  const searching = !!q.trim() || !!category;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Ajuda e Suporte</h1>
        <p className="mt-1 text-muted-foreground">Encontre a resposta na base de conhecimento ou abra um chamado para a equipe CÓRTEX.</p>
      </div>
      <HelpTabs />

      <div className="relative max-w-2xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <label htmlFor="help-search" className="sr-only">
          Pesquisar na ajuda
        </label>
        <Input
          id="help-search"
          data-testid="help-search"
          className="pl-9"
          placeholder="Ex.: pagamento não confirmado, cancelar venda, garantia"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={120}
        />
      </div>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Categorias">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(category?.id === c.id ? null : c)}
              aria-pressed={category?.id === c.id}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                category?.id === c.id ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {c.name} <span className="opacity-70">({c.articles})</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="flex items-center gap-2 text-sm text-danger" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden /> {error}
        </p>
      )}

      {searching ? (
        <section aria-live="polite" className="space-y-3">
          {loading ? (
            <p className="text-muted-foreground">Pesquisando…</p>
          ) : results.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <BookOpen className="mx-auto mb-3 h-10 w-10 text-muted-foreground" aria-hidden />
                <p className="font-medium text-foreground">Nenhum artigo encontrado.</p>
                <p className="mb-4 text-sm text-muted-foreground">Tente outras palavras ou fale com a equipe de suporte.</p>
                <Link href={NEW_TICKET_PATH}>
                  <Button tabIndex={-1}>Abrir um chamado</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-2" data-testid="help-results">
              {results.map((a) => (
                <li key={a.id}>
                  <Link href={`/dashboard/help/articles/${a.slug}`} className="block rounded-lg border border-border p-4 transition-colors hover:bg-accent">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{a.title}</span>
                      <Badge variant="outline">{a.category.name}</Badge>
                    </div>
                    {a.summary && <p className="mt-1 text-sm text-muted-foreground">{a.summary}</p>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <LifeBuoy className="mt-0.5 h-6 w-6 text-muted-foreground" aria-hidden />
              <div>
                <p className="font-medium text-foreground">Não encontrou o que precisava?</p>
                <p className="text-sm text-muted-foreground">Abra um chamado. Seu nome, empresa e filial vão automaticamente.</p>
              </div>
            </div>
            <Link href={NEW_TICKET_PATH}>
              <Button tabIndex={-1}>Novo chamado</Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
