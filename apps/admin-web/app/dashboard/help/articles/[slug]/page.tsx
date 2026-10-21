'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { HelpTabs } from '@/components/support/HelpTabs';
import { getApiErrorMessage } from '@/lib/errors';
import { supportApi, type KbArticle } from '@/lib/api/support';
import { buildReportHref, HELP_HOME, NEW_TICKET_PATH } from '@/lib/support';

/** Artigo publicado da base de conhecimento. Texto puro com quebras de linha preservadas (nada de HTML injetado). */
export default function HelpArticlePage() {
  const { slug } = useParams<{ slug: string }>();
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setError(null);
    supportApi
      .article(slug)
      .then(setArticle)
      .catch((err) => setError(getApiErrorMessage(err, 'Não foi possível abrir o artigo.')));
  }, [slug]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Ajuda e Suporte</h1>
      </div>
      <HelpTabs />
      <Link href={HELP_HOME} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden /> Voltar para a pesquisa
      </Link>

      {error ? (
        <Card>
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-danger" aria-hidden />
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      ) : !article ? (
        <p className="text-muted-foreground">Carregando…</p>
      ) : (
        <article className="max-w-3xl space-y-4" data-testid="help-article">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{article.category.name}</Badge>
            {article.moduleLabel && <Badge variant="secondary">{article.moduleLabel}</Badge>}
          </div>
          <h2 className="text-2xl font-semibold text-foreground">{article.title}</h2>
          {article.summary && <p className="text-muted-foreground">{article.summary}</p>}
          <div className="whitespace-pre-line break-words leading-relaxed text-foreground">{article.body}</div>
          <p className="text-xs text-muted-foreground">Atualizado em {new Date(article.updatedAt).toLocaleDateString('pt-BR')}</p>
          <Card>
            <CardContent className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-foreground">Ainda precisa de ajuda com isso?</p>
              <Link href={article.module ? buildReportHref({ module: article.module, screen: `Artigo: ${article.title}` }) : NEW_TICKET_PATH}>
                <Button variant="outline" tabIndex={-1}>
                  Abrir um chamado
                </Button>
              </Link>
            </CardContent>
          </Card>
        </article>
      )}
    </div>
  );
}
