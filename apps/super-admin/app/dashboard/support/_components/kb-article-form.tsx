'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { SupportKbArticleInput } from '@/lib/api';
import { InlineNotice } from './states';
import type { KbArticle, KbCategory, SupportCatalog } from '../_lib/types';

export interface ArticleFormValues {
  title: string;
  summary: string;
  body: string;
  keywords: string;
  module: string;
  categoryId: string;
  slug: string;
}

export function valuesFromArticle(a?: KbArticle | null): ArticleFormValues {
  return {
    title: a?.title ?? '',
    summary: a?.summary ?? '',
    body: a?.body ?? '',
    keywords: a?.keywords ?? '',
    module: a?.module ?? '',
    categoryId: a?.category?.id ?? '',
    slug: a?.slug ?? '',
  };
}

/** Converte o formulário no corpo da API (vazio → null nos campos opcionais; slug só quando preenchido/alterado). */
export function toPayload(v: ArticleFormValues, original?: KbArticle | null): SupportKbArticleInput {
  const payload: SupportKbArticleInput = {
    title: v.title.trim(),
    summary: v.summary.trim() || null,
    body: v.body.trim(),
    keywords: v.keywords.trim() || null,
    module: v.module || null,
    categoryId: v.categoryId,
  };
  const slug = v.slug.trim();
  if (slug && slug !== original?.slug) payload.slug = slug;
  return payload;
}

interface Props {
  initial: ArticleFormValues;
  categories: KbCategory[];
  catalog: SupportCatalog | null;
  submitLabel: string;
  saving: boolean;
  error: string;
  onSubmit: (values: ArticleFormValues) => void;
  onCancel?: () => void;
}

export function KbArticleForm({ initial, categories, catalog, submitLabel, saving, error, onSubmit, onCancel }: Props) {
  const [v, setV] = useState<ArticleFormValues>(initial);
  const [localError, setLocalError] = useState('');
  const set = (k: keyof ArticleFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Checagem rápida para o usuário; as regras valem no servidor.
    if (v.title.trim().length < 3) return setLocalError('Título: mínimo 3 caracteres.');
    if (!v.categoryId) return setLocalError('Escolha a categoria.');
    if (v.body.trim().length < 10) return setLocalError('Conteúdo: mínimo 10 caracteres.');
    setLocalError('');
    onSubmit(v);
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="kb-article-form">
      <div className="space-y-1">
        <Label htmlFor="kb-title">Título</Label>
        <Input id="kb-title" value={v.title} onChange={set('title')} maxLength={160} placeholder="Ex.: Como cancelar uma venda?" data-testid="kb-title" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="kb-category">Categoria</Label>
          <Select id="kb-category" value={v.categoryId} onChange={set('categoryId')} data-testid="kb-category">
            <option value="">Escolha...</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isActive ? '' : ' (inativa)'}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="kb-module">Módulo</Label>
          <Select id="kb-module" value={v.module} onChange={set('module')} data-testid="kb-module">
            <option value="">Nenhum (geral)</option>
            {(catalog?.modules ?? []).map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="kb-summary">Resumo</Label>
        <Input id="kb-summary" value={v.summary} onChange={set('summary')} maxLength={300} placeholder="Uma frase que aparece na lista de resultados" data-testid="kb-summary" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="kb-body">Conteúdo</Label>
        <Textarea id="kb-body" rows={14} value={v.body} onChange={set('body')} maxLength={50000} className="font-mono text-[13px]" placeholder="Texto simples. Quebras de linha são mantidas como estão." data-testid="kb-body" />
        <p className="text-xs text-muted-foreground">Texto simples: sem formatação HTML. Use linhas em branco para separar parágrafos e “1.”/“-” para listas.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="kb-keywords">Palavras-chave</Label>
          <Input id="kb-keywords" value={v.keywords} onChange={set('keywords')} maxLength={300} placeholder="Ex.: estorno cancelar devolução" data-testid="kb-keywords" />
          <p className="text-xs text-muted-foreground">Termos que as pessoas digitam na busca, separados por espaço.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="kb-slug">Endereço (slug)</Label>
          <Input id="kb-slug" value={v.slug} onChange={set('slug')} maxLength={80} placeholder="gerado a partir do título" data-testid="kb-slug" />
          <p className="text-xs text-muted-foreground">Opcional. Deixe em branco para gerar automaticamente.</p>
        </div>
      </div>
      {(localError || error) && <InlineNotice tone="error">{localError || error}</InlineNotice>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving} data-testid="kb-save">
          {saving ? 'Salvando...' : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
