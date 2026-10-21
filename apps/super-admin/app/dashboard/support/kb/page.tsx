'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { supportAdminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '../_components/confirm-dialog';
import { Badge, EmptyState, ErrorState, InlineNotice, LoadingState, PageTitle } from '../_components/states';
import { errorText, formatDateTime } from '../_lib/format';
import type { KbArticle, KbCategory } from '../_lib/types';

const KB_STATUS_LABELS: Record<string, string> = { DRAFT: 'Rascunho', PUBLISHED: 'Publicado' };

export default function KbListPage() {
  const [filters, setFilters] = useState({ status: '', category: '', q: '' });
  const [applied, setApplied] = useState(filters);
  const [rows, setRows] = useState<KbArticle[] | null>(null);
  const [categories, setCategories] = useState<KbCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toggle, setToggle] = useState<KbArticle | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: { status?: string; category?: string; q?: string } = {};
      if (applied.status) params.status = applied.status;
      if (applied.category) params.category = applied.category;
      if (applied.q.trim()) params.q = applied.q.trim();
      const res = await supportAdminApi.kbArticles(params);
      setRows(res.data);
    } catch (err) {
      setError(errorText(err, 'Não foi possível carregar os artigos.'));
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    supportAdminApi
      .kbCategories()
      .then((res) => setCategories(res.data))
      .catch(() => setCategories([]));
  }, []);

  async function confirmToggle() {
    if (!toggle) return;
    const next = toggle.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED';
    setBusy(true);
    setNotice(null);
    try {
      await supportAdminApi.kbSetArticleStatus(toggle.id, next);
      setNotice({ tone: 'success', text: next === 'PUBLISHED' ? `“${toggle.title}” publicado.` : `“${toggle.title}” voltou para rascunho.` });
      setToggle(null);
      load();
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'Não foi possível alterar a publicação.') });
      setToggle(null);
    } finally {
      setBusy(false);
    }
  }

  const filtered = !!(applied.status || applied.category || applied.q.trim());

  return (
    <div className="space-y-4">
      <PageTitle
        title="Base de conhecimento"
        description="Artigos de ajuda lidos pelas empresas. Só os publicados aparecem para os clientes."
        actions={
          <Button asChild size="sm" data-testid="kb-new">
            <Link href="/dashboard/support/kb/new">
              <Plus className="mr-2 h-4 w-4" />
              Novo artigo
            </Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="p-4">
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(filters);
            }}
          >
            <div className="space-y-1 sm:col-span-2 lg:col-span-1">
              <Label className="text-xs" htmlFor="kb-q">Buscar</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="kb-q" className="h-9 pl-9 text-sm" value={filters.q} placeholder="Título, resumo ou palavra-chave" onChange={(e) => setFilters({ ...filters, q: e.target.value })} data-testid="kb-filter-q" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="kb-status">Situação</Label>
              <Select id="kb-status" className="h-9 text-sm" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} data-testid="kb-filter-status">
                <option value="">Todas</option>
                <option value="PUBLISHED">Publicados</option>
                <option value="DRAFT">Rascunhos</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="kb-cat">Categoria</Label>
              <Select id="kb-cat" className="h-9 text-sm" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
                <option value="">Todas</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit" size="sm" data-testid="kb-filter-apply">
                Filtrar
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const empty = { status: '', category: '', q: '' };
                  setFilters(empty);
                  setApplied(empty);
                }}
              >
                Limpar
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {notice && <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>}

      {loading && !rows ? (
        <LoadingState label="Carregando artigos..." />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState message={filtered ? 'Nenhum artigo encontrado com esses filtros.' : 'Nenhum artigo ainda. Crie o primeiro.'} />
      ) : (
        <Card className={cn(loading && 'opacity-60')}>
          <ul className="divide-y" data-testid="kb-list">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between" data-testid="kb-row" data-article-id={a.id} data-status={a.status}>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/support/kb/${a.id}`} className="break-words font-medium hover:underline">
                      {a.title}
                    </Link>
                    <Badge className={a.status === 'PUBLISHED' ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground'}>{KB_STATUS_LABELS[a.status] ?? a.status}</Badge>
                  </div>
                  {a.summary && <p className="line-clamp-2 break-words text-sm text-muted-foreground">{a.summary}</p>}
                  <p className="text-xs text-muted-foreground">
                    {a.category?.name}
                    {a.moduleLabel ? ` · ${a.moduleLabel}` : ''} · atualizado em {formatDateTime(a.updatedAt)} · {a.author?.name}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/dashboard/support/kb/${a.id}`}>Editar</Link>
                  </Button>
                  <Button size="sm" variant={a.status === 'PUBLISHED' ? 'outline' : 'default'} onClick={() => setToggle(a)} data-testid="kb-publish-toggle">
                    {a.status === 'PUBLISHED' ? 'Despublicar' : 'Publicar'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t p-4 text-sm text-muted-foreground">{rows.length} artigo(s)</p>
        </Card>
      )}

      <ConfirmDialog
        open={!!toggle}
        title={toggle?.status === 'PUBLISHED' ? 'Despublicar artigo?' : 'Publicar artigo?'}
        description={
          toggle?.status === 'PUBLISHED'
            ? `“${toggle?.title ?? ''}” deixa de aparecer para as empresas e volta a ser rascunho.`
            : `“${toggle?.title ?? ''}” passa a aparecer na Central de Ajuda de todas as empresas.`
        }
        confirmLabel={toggle?.status === 'PUBLISHED' ? 'Despublicar' : 'Publicar'}
        busy={busy}
        onConfirm={confirmToggle}
        onCancel={() => setToggle(null)}
        testId="kb-confirm-status"
      />
    </div>
  );
}
