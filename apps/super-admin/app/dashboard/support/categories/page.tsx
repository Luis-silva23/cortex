'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supportAdminApi } from '@/lib/api';
import { Badge, EmptyState, ErrorState, InlineNotice, LoadingState, PageTitle } from '../_components/states';
import { errorText } from '../_lib/format';
import type { KbCategory } from '../_lib/types';

export default function KbCategoriesPage() {
  const [rows, setRows] = useState<KbCategory[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; sortOrder: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await supportAdminApi.kbCategories();
      setRows(res.data as KbCategory[]);
    } catch (err) {
      setLoadError(errorText(err, 'Não foi possível carregar as categorias.'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setNotice({ tone: 'error', text: 'Informe o nome da categoria (mínimo 2 caracteres).' });
    setBusyId('new');
    setNotice(null);
    try {
      await supportAdminApi.kbCreateCategory({ name: name.trim(), sortOrder: Number(sortOrder) || 0 });
      setName('');
      setSortOrder('0');
      setNotice({ tone: 'success', text: 'Categoria criada.' });
      load();
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'Não foi possível criar a categoria.') });
    } finally {
      setBusyId(null);
    }
  }

  async function update(id: string, body: { name?: string; sortOrder?: number; isActive?: boolean }, okText: string) {
    setBusyId(id);
    setNotice(null);
    try {
      await supportAdminApi.kbUpdateCategory(id, body);
      setEditing(null);
      setNotice({ tone: 'success', text: okText });
      load();
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'Não foi possível salvar a categoria.') });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle title="Categorias" description="Agrupam os artigos da base de conhecimento. Uma categoria inativa some da Central de Ajuda, e os artigos dela também." />

      <Card>
        <CardContent className="p-4">
          <form onSubmit={create} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end" data-testid="category-form">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="cat-name">Nova categoria</Label>
              <Input id="cat-name" className="h-9 text-sm" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="category-name" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="cat-order">Ordem</Label>
              <Input id="cat-order" className="h-9 text-sm" type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={busyId === 'new'} data-testid="category-create">
              Criar
            </Button>
          </form>
        </CardContent>
      </Card>

      {notice && <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>}

      {loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : !rows ? (
        <LoadingState label="Carregando categorias..." />
      ) : rows.length === 0 ? (
        <EmptyState message="Nenhuma categoria ainda. Crie a primeira acima." />
      ) : (
        <Card>
          <ul className="divide-y" data-testid="category-list">
            {rows.map((c) => (
              <li key={c.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="category-row">
                {editing?.id === c.id ? (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <Input className="h-9 max-w-xs text-sm" value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Nome da categoria" />
                    <Input className="h-9 w-24 text-sm" type="number" value={editing.sortOrder} onChange={(e) => setEditing({ ...editing, sortOrder: e.target.value })} aria-label="Ordem" />
                    <Button size="sm" disabled={busyId === c.id} onClick={() => update(c.id, { name: editing.name.trim(), sortOrder: Number(editing.sortOrder) || 0 }, 'Categoria atualizada.')}>
                      Salvar
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                      Cancelar
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-words font-medium">{c.name}</span>
                        <Badge className={c.isActive ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground'}>{c.isActive ? 'Ativa' : 'Inativa'}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {c.articles} artigo(s) · ordem {c.sortOrder}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditing({ id: c.id, name: c.name, sortOrder: String(c.sortOrder) })}>
                        Editar
                      </Button>
                      <Button size="sm" variant="outline" disabled={busyId === c.id} onClick={() => update(c.id, { isActive: !c.isActive }, c.isActive ? 'Categoria desativada.' : 'Categoria ativada.')}>
                        {c.isActive ? 'Desativar' : 'Ativar'}
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
