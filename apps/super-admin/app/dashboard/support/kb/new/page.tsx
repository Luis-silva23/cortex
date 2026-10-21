'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { supportAdminApi } from '@/lib/api';
import { KbArticleForm, toPayload, valuesFromArticle, type ArticleFormValues } from '../../_components/kb-article-form';
import { PageTitle } from '../../_components/states';
import { errorText } from '../../_lib/format';
import { useSupportCatalog } from '../../_lib/hooks';
import type { KbCategory } from '../../_lib/types';

export default function NewKbArticlePage() {
  const router = useRouter();
  const { catalog } = useSupportCatalog();
  const [categories, setCategories] = useState<KbCategory[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supportAdminApi
      .kbCategories()
      .then((res) => setCategories((res.data as KbCategory[]).filter((c) => c.isActive)))
      .catch(() => setError('Não foi possível carregar as categorias.'));
  }, []);

  async function save(values: ArticleFormValues) {
    setSaving(true);
    setError('');
    try {
      await supportAdminApi.kbCreateArticle(toPayload(values));
      router.push('/dashboard/support/kb');
    } catch (err) {
      setError(errorText(err, 'Não foi possível salvar o artigo.'));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle title="Novo artigo" description="O artigo nasce como rascunho. Publique na lista quando estiver pronto." />
      <Card>
        <CardContent className="p-4 sm:p-6">
          <KbArticleForm
            initial={valuesFromArticle(null)}
            categories={categories}
            catalog={catalog}
            submitLabel="Salvar rascunho"
            saving={saving}
            error={error}
            onSubmit={save}
            onCancel={() => router.push('/dashboard/support/kb')}
          />
        </CardContent>
      </Card>
      <Link href="/dashboard/support/categories" className="text-sm text-muted-foreground hover:underline">
        Gerenciar categorias
      </Link>
    </div>
  );
}
