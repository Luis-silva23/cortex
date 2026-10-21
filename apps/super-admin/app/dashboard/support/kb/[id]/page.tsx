'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { supportAdminApi } from '@/lib/api';
import { KbArticleForm, toPayload, valuesFromArticle, type ArticleFormValues } from '../../_components/kb-article-form';
import { Badge, ErrorState, InlineNotice, LoadingState, PageTitle } from '../../_components/states';
import { errorText } from '../../_lib/format';
import { useSupportCatalog } from '../../_lib/hooks';
import type { KbArticle, KbCategory } from '../../_lib/types';

export default function EditKbArticlePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { catalog } = useSupportCatalog();
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [categories, setCategories] = useState<KbCategory[]>([]);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([supportAdminApi.kbArticle(id), supportAdminApi.kbCategories()])
      .then(([a, c]) => {
        setArticle(a.data as KbArticle);
        setCategories(c.data as KbCategory[]);
      })
      .catch((err) => setLoadError(errorText(err, 'Não foi possível carregar o artigo.')));
  }, [id]);

  async function save(values: ArticleFormValues) {
    if (!article) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await supportAdminApi.kbUpdateArticle(article.id, toPayload(values, article));
      setArticle(res.data as KbArticle);
      setSaved(true);
    } catch (err) {
      setError(errorText(err, 'Não foi possível salvar o artigo.'));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <ErrorState message={loadError} onRetry={() => router.refresh()} />;
  if (!article) return <LoadingState label="Carregando artigo..." />;

  return (
    <div className="space-y-4">
      <PageTitle
        title="Editar artigo"
        description="Mudanças em um artigo publicado aparecem para as empresas assim que forem salvas."
        actions={
          <Badge className={article.status === 'PUBLISHED' ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground'}>
            {article.status === 'PUBLISHED' ? 'Publicado' : 'Rascunho'}
          </Badge>
        }
      />
      {saved && <InlineNotice tone="success">Artigo salvo.</InlineNotice>}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <KbArticleForm
            key={article.updatedAt}
            initial={valuesFromArticle(article)}
            categories={categories}
            catalog={catalog}
            submitLabel="Salvar alterações"
            saving={saving}
            error={error}
            onSubmit={save}
            onCancel={() => router.push('/dashboard/support/kb')}
          />
        </CardContent>
      </Card>
    </div>
  );
}
